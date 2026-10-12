import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { ClaimsService } from './claims.service';
import { Claim, ClaimStatus } from './entities/claim.entity';
import { OrderService } from '../order/order.service';
import { S3Service } from '../s3/s3.service';
import { S3CleanupService } from '../s3/s3-cleanup.service';
import { RoleType } from '../common/constants/role-type.enum';

/**
 * Un reclamo cuelga de un pedido: tiene que existir, ser del cliente que
 * reclama y hereda la distribuidora del pedido. Al resolverlo, sólo lo toca un
 * administrador de esa distribuidora.
 */
describe('ClaimsService', () => {
  let service: ClaimsService;
  let claims: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findAndCount: jest.Mock;
    findOne: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let bloqueo: { setLock: jest.Mock; andWhere: jest.Mock };
  let orders: { findOne: jest.Mock; assertDeLaDistribuidora: jest.Mock };
  let storage: {
    put: jest.Mock;
    getSignedDownload: jest.Mock;
  };
  let cleanup: {
    removeInBackground: jest.Mock;
    reserveUpload: jest.Mock;
    confirmUpload: jest.Mock;
    scheduleRemoval: jest.Mock;
  };

  const dto = {
    orderId: 'o1',
    customerId: 'u1',
    reason: 'Fuga',
    description: 'Pierde gas',
  };

  beforeEach(() => {
    claims = {
      create: jest.fn((d: Partial<Claim>) => d),
      save: jest.fn((c: Claim) => Promise.resolve(c)),
      find: jest.fn(),
      findAndCount: jest.fn(),
      findOne: jest.fn(),
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) => fn(txManager)),
      },
    };
    bloqueo = {
      setLock: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
    };
    // `resolve`/`take`/`reopen` leen con lock y guardan en una transacción:
    // la lectura con lock y el guardado del manager reusan los mismos mocks.
    const txManager = {
      createQueryBuilder: jest.fn(() => ({
        setLock: bloqueo.setLock,
        where: jest.fn().mockReturnThis(),
        andWhere: bloqueo.andWhere,
        getOne: claims.findOne,
      })),
      save: claims.save,
    };
    orders = { findOne: jest.fn(), assertDeLaDistribuidora: jest.fn() };
    storage = {
      put: jest.fn().mockResolvedValue(undefined),
      getSignedDownload: jest.fn(),
    };
    cleanup = {
      removeInBackground: jest.fn(),
      reserveUpload: jest.fn().mockResolvedValue(undefined),
      confirmUpload: jest.fn().mockResolvedValue(undefined),
      scheduleRemoval: jest.fn().mockResolvedValue(undefined),
    };
    service = new ClaimsService(
      claims as unknown as Repository<Claim>,
      orders as unknown as OrderService,
      storage as unknown as S3Service,
      cleanup as unknown as S3CleanupService,
    );
  });

  it('el reclamo hereda la distribuidora del pedido', async () => {
    orders.findOne.mockResolvedValue({
      customerId: 'u1',
      distributorId: 'd1',
    });
    const claim = await service.create(dto);
    expect(claim.distributorId).toBe('d1');
  });

  it('no se puede reclamar un pedido ajeno', async () => {
    orders.findOne.mockResolvedValue({ customerId: 'otro' });
    await expect(service.create(dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(claims.save).not.toHaveBeenCalled();
  });

  it('un pedido inexistente es 404', async () => {
    orders.findOne.mockRejectedValue(new NotFoundException());
    await expect(service.create(dto)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un admin no resuelve reclamos de otra distribuidora', async () => {
    claims.findOne.mockResolvedValue(null);
    await expect(
      service.resolve('c1', 'ok', ClaimStatus.RESOLVED, 'd2'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(claims.save).not.toHaveBeenCalled();
    // El filtro por distribuidora va en la consulta con lock.
    expect(bloqueo.andWhere).toHaveBeenCalledWith(
      'claim.distributorId = :distributorId',
      { distributorId: 'd2' },
    );
  });

  it('take y reopen también acotan por la distribuidora', async () => {
    claims.findOne.mockResolvedValue(null);
    await expect(service.take('c1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.reopen('c1', 'm', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(bloqueo.andWhere).toHaveBeenCalledTimes(2);
    expect(bloqueo.andWhere).toHaveBeenCalledWith(
      'claim.distributorId = :distributorId',
      { distributorId: 'd2' },
    );
  });

  it('sin distribuidora (cross-tenant) no agrega el filtro', async () => {
    claims.findOne.mockResolvedValue({
      claimId: 'c1',
      status: ClaimStatus.PENDING,
    });
    await service.take('c1');
    expect(bloqueo.andWhere).not.toHaveBeenCalled();
  });

  it('resolver guarda la nota y el estado', async () => {
    claims.findOne.mockResolvedValue({
      claimId: 'c1',
      status: ClaimStatus.PENDING,
    });
    const r = await service.resolve('c1', 'Se cambió', ClaimStatus.RESOLVED);
    expect(r).toMatchObject({
      resolutionNote: 'Se cambió',
      status: ClaimStatus.RESOLVED,
    });
  });

  it('con distribuidora en contexto, el pedido de otra es 404', async () => {
    orders.assertDeLaDistribuidora.mockRejectedValue(new NotFoundException());
    await expect(service.create(dto, 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(orders.assertDeLaDistribuidora).toHaveBeenCalledWith('o1', 'd1');
    expect(claims.save).not.toHaveBeenCalled();
  });

  describe('mis reclamos', () => {
    it('filtra por el cliente y la distribuidora, pagina y trae el total', async () => {
      claims.findAndCount.mockResolvedValue([[{ claimId: 'c1' }], 7]);
      await expect(
        service.findMine('u1', { limit: 5, offset: 10 }, 'd1'),
      ).resolves.toEqual([[{ claimId: 'c1' }], 7]);
      expect(claims.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { customerId: 'u1', distributorId: 'd1' },
          take: 5,
          skip: 10,
          order: { createdAt: 'DESC' },
          relations: ['order'],
        }),
      );
    });

    it('sin distribuidora en contexto filtra sólo por el cliente', async () => {
      claims.findAndCount.mockResolvedValue([[], 0]);
      await service.findMine('u1', {}, null);
      expect(claims.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { customerId: 'u1' },
          take: 10,
          skip: 0,
        }),
      );
    });
  });

  describe('ficha y edición', () => {
    it('la ficha trae pedido y cliente y acota por distribuidora', async () => {
      claims.findOne.mockResolvedValue({ claimId: 'c1' });
      await service.findDetail('c1', 'd1');
      expect(claims.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { claimId: 'c1', distributorId: 'd1' },
          relations: ['order', 'customer'],
        }),
      );
    });

    it('la ficha de un reclamo de otra distribuidora es 404', async () => {
      claims.findOne.mockResolvedValue(null);
      await expect(service.findDetail('c1', 'otra')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('edita motivo y descripción de un reclamo pendiente', async () => {
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.PENDING,
        reason: 'a',
        description: 'b',
      });
      await service.update('c1', { description: 'nueva' }, 'd1');
      expect(claims.save).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'a', description: 'nueva' }),
      );
    });

    it.each([
      ClaimStatus.IN_PROCESS,
      ClaimStatus.RESOLVED,
      ClaimStatus.REJECTED,
    ])('un reclamo %s no se edita (409)', async (status) => {
      claims.findOne.mockResolvedValue({ claimId: 'c1', status });
      await expect(
        service.update('c1', { reason: 'x' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(claims.save).not.toHaveBeenCalled();
    });
  });

  describe('máquina de estados', () => {
    it('resolve rechaza un salto inválido (resolved → rejected sin reabrir)', async () => {
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.RESOLVED,
      });
      await expect(
        service.resolve('c1', 'otra vez', ClaimStatus.REJECTED),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(claims.save).not.toHaveBeenCalled();
    });

    it('resolve, take y reopen leen el reclamo con lock pesimista (FOR UPDATE)', async () => {
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.PENDING,
      });
      await service.resolve('c1', 'ok', ClaimStatus.RESOLVED);
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.PENDING,
      });
      await service.take('c1');
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.RESOLVED,
      });
      await service.reopen('c1', 'motivo');
      expect(bloqueo.setLock).toHaveBeenCalledTimes(3);
      expect(bloqueo.setLock).toHaveBeenCalledWith('pessimistic_write');
    });

    it('resolve rechaza repetir el estado: no pisa la nota', async () => {
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.IN_PROCESS,
        resolutionNote: 'nota previa',
      });
      await expect(
        service.resolve('c1', 'otra nota', ClaimStatus.IN_PROCESS),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(claims.save).not.toHaveBeenCalled();
    });

    it('take pasa un reclamo pendiente a in_process sin pisar la nota', async () => {
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.PENDING,
        resolutionNote: null,
      });
      const r = await service.take('c1');
      expect(r).toMatchObject({
        status: ClaimStatus.IN_PROCESS,
        resolutionNote: null,
      });
    });

    it('take rechaza un reclamo que no está pendiente', async () => {
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.IN_PROCESS,
      });
      await expect(service.take('c1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(claims.save).not.toHaveBeenCalled();
    });

    it('reopen vuelve a in_process un reclamo resuelto y guarda el motivo', async () => {
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.RESOLVED,
      });
      const r = await service.reopen('c1', 'El cliente mandó más info');
      expect(r).toMatchObject({
        status: ClaimStatus.IN_PROCESS,
        resolutionNote: 'El cliente mandó más info',
      });
    });

    it('reopen rechaza un reclamo pendiente o en proceso', async () => {
      claims.findOne.mockResolvedValue({
        claimId: 'c1',
        status: ClaimStatus.PENDING,
      });
      await expect(service.reopen('c1', 'motivo')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(claims.save).not.toHaveBeenCalled();
    });

    it('un admin no toma/reabre reclamos de otra distribuidora (404)', async () => {
      claims.findOne.mockResolvedValue(null);
      await expect(service.take('c1', 'd2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.reopen('c1', 'motivo', 'd2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('foto del reclamo', () => {
    const CLIENTE = { userId: 'u1', role: RoleType.CUSTOMER };
    const ADMIN = { userId: 'a1', role: RoleType.ADMIN };
    const PNG = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    const archivo = (over: Partial<Express.Multer.File> = {}) =>
      ({
        buffer: PNG,
        size: PNG.length,
        mimetype: 'image/png',
        originalname: 'foto.png',
        ...over,
      }) as Express.Multer.File;
    const reclamo = (over: Partial<Claim> = {}) =>
      ({
        claimId: 'c1',
        distributorId: 'd1',
        customerId: 'u1',
        status: ClaimStatus.PENDING,
        photoKey: null,
        photoUrl: 'https://viejo/ext.jpg',
        ...over,
      }) as Claim;

    it('guarda la foto en claims/{distribuidora}/{reclamo}/{uuid}.{ext} y limpia la URL externa', async () => {
      claims.findOne.mockResolvedValue(reclamo());
      const r = await service.uploadPhoto('c1', archivo(), null, CLIENTE);
      const [put] = storage.put.mock.calls[0] as [
        { key: string; contentType: string },
      ];
      expect(put.key).toMatch(/^claims\/d1\/c1\/[0-9a-f-]{36}\.png$/);
      expect(put.contentType).toBe('image/png');
      expect(r.photoKey).toBe(put.key);
      expect(r.photoUrl).toBeNull();
      expect(cleanup.removeInBackground).not.toHaveBeenCalled();
      // Reserva antes del put y confirmación en la transacción del reclamo.
      expect(cleanup.reserveUpload).toHaveBeenCalledWith(put.key);
      expect(cleanup.reserveUpload.mock.invocationCallOrder[0]).toBeLessThan(
        storage.put.mock.invocationCallOrder[0],
      );
      expect(cleanup.confirmUpload).toHaveBeenCalledWith(
        expect.anything(),
        put.key,
      );
      // Se serializa con lock pesimista (dos subidas simultáneas no se pisan).
      expect(bloqueo.setLock).toHaveBeenCalledWith('pessimistic_write');
    });

    it('reemplazar la foto borra la anterior', async () => {
      claims.findOne.mockResolvedValue(
        reclamo({ photoKey: 'claims/viejo.jpg' }),
      );
      await service.uploadPhoto('c1', archivo(), null, CLIENTE);
      // El borrado de la anterior se anota en la transacción y recién después se intenta.
      expect(cleanup.scheduleRemoval).toHaveBeenCalledWith(
        expect.anything(),
        'claims/viejo.jpg',
      );
      expect(cleanup.removeInBackground).toHaveBeenCalledWith(
        'claims/viejo.jpg',
      );
      expect(cleanup.scheduleRemoval.mock.invocationCallOrder[0]).toBeLessThan(
        cleanup.removeInBackground.mock.invocationCallOrder[0],
      );
    });

    describe('sacar la foto (DELETE)', () => {
      it('deja la referencia en null, anota la key en la transacción y recién después la borra', async () => {
        const fila = reclamo({ photoKey: 'claims/d1/c1/x.png' });
        claims.findOne.mockResolvedValue(fila);
        const res = await service.removePhoto('c1', null, CLIENTE);
        expect(res.photoKey).toBeNull();
        expect(claims.save).toHaveBeenCalled();
        expect(cleanup.scheduleRemoval).toHaveBeenCalledWith(
          expect.anything(),
          'claims/d1/c1/x.png',
        );
        expect(cleanup.removeInBackground).toHaveBeenCalledWith(
          'claims/d1/c1/x.png',
        );
        expect(
          cleanup.scheduleRemoval.mock.invocationCallOrder[0],
        ).toBeLessThan(cleanup.removeInBackground.mock.invocationCallOrder[0]);
      });

      it('un reclamo sin foto no borra nada', async () => {
        claims.findOne.mockResolvedValue(reclamo());
        await service.removePhoto('c1', null, ADMIN);
        expect(cleanup.scheduleRemoval).not.toHaveBeenCalled();
        expect(cleanup.removeInBackground).not.toHaveBeenCalled();
      });

      it('resuelto o rechazado: 409 y no toca nada', async () => {
        for (const status of [ClaimStatus.RESOLVED, ClaimStatus.REJECTED]) {
          claims.findOne.mockResolvedValue(
            reclamo({ status, photoKey: 'claims/x.png' }),
          );
          await expect(
            service.removePhoto('c1', null, CLIENTE),
          ).rejects.toBeInstanceOf(ConflictException);
        }
        expect(claims.save).not.toHaveBeenCalled();
        expect(cleanup.removeInBackground).not.toHaveBeenCalled();
      });

      it('si lo cierran justo antes del lock, 409 y no se borra el objeto', async () => {
        claims.findOne
          .mockResolvedValueOnce(reclamo({ photoKey: 'claims/x.png' }))
          .mockResolvedValueOnce(
            reclamo({ status: ClaimStatus.RESOLVED, photoKey: 'claims/x.png' }),
          );
        await expect(
          service.removePhoto('c1', null, CLIENTE),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(cleanup.removeInBackground).not.toHaveBeenCalled();
      });

      it('un cliente no saca la foto del reclamo de otro (404) y el admin queda acotado a su distribuidora', async () => {
        claims.findOne.mockResolvedValue(null);
        await expect(
          service.removePhoto('c1', null, CLIENTE),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(claims.findOne).toHaveBeenCalledWith({
          where: { claimId: 'c1', customerId: 'u1' },
        });
        await expect(
          service.removePhoto('c1', 'd2', ADMIN),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(claims.findOne).toHaveBeenLastCalledWith({
          where: { claimId: 'c1', distributorId: 'd2' },
        });
        expect(cleanup.removeInBackground).not.toHaveBeenCalled();
      });
    });

    it('si el reclamo no se puede guardar, la foto recién subida no queda huérfana', async () => {
      claims.findOne.mockResolvedValue(reclamo());
      claims.save.mockRejectedValue(new Error('base caída'));
      await expect(
        service.uploadPhoto('c1', archivo(), null, CLIENTE),
      ).rejects.toThrow('base caída');
      const [{ key }] = storage.put.mock.calls[0] as [{ key: string }];
      expect(cleanup.removeInBackground).toHaveBeenCalledWith(key);
    });

    it('un reclamo resuelto o rechazado no admite cambiar la foto (409) y no sube nada', async () => {
      for (const status of [ClaimStatus.RESOLVED, ClaimStatus.REJECTED]) {
        claims.findOne.mockResolvedValue(reclamo({ status }));
        await expect(
          service.uploadPhoto('c1', archivo(), null, CLIENTE),
        ).rejects.toBeInstanceOf(ConflictException);
      }
      expect(cleanup.reserveUpload).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('si lo cierran mientras se sube (dentro del lock), 409 y la foto subida se borra', async () => {
      claims.findOne
        .mockResolvedValueOnce(reclamo())
        .mockResolvedValueOnce(reclamo({ status: ClaimStatus.RESOLVED }));
      await expect(
        service.uploadPhoto('c1', archivo(), null, CLIENTE),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(claims.save).not.toHaveBeenCalled();
      expect(cleanup.confirmUpload).not.toHaveBeenCalled();
      expect(cleanup.removeInBackground).toHaveBeenCalledTimes(1);
    });

    it('un cliente no sube foto al reclamo de otro (404)', async () => {
      claims.findOne.mockResolvedValue(null);
      await expect(
        service.uploadPhoto('c1', archivo(), null, CLIENTE),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(claims.findOne).toHaveBeenCalledWith({
        where: { claimId: 'c1', customerId: 'u1' },
      });
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('un admin queda acotado a su distribuidora', async () => {
      claims.findOne.mockResolvedValue(null);
      await expect(
        service.uploadPhoto('c1', archivo(), 'd2', ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(claims.findOne).toHaveBeenCalledWith({
        where: { claimId: 'c1', distributorId: 'd2' },
      });
    });

    it('rechaza lo que no es imagen (415), lo que no coincide con su firma (415), lo vacío y lo enorme', async () => {
      claims.findOne.mockResolvedValue(reclamo());
      await expect(
        service.uploadPhoto(
          'c1',
          archivo({ mimetype: 'application/pdf' }),
          null,
          CLIENTE,
        ),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      await expect(
        service.uploadPhoto(
          'c1',
          archivo({ buffer: Buffer.from('<html>'), size: 6 }),
          null,
          CLIENTE,
        ),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      await expect(
        service.uploadPhoto('c1', archivo({ size: 0 }), null, CLIENTE),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.uploadPhoto(
          'c1',
          archivo({ size: 10 * 1024 * 1024 + 1 }),
          null,
          CLIENTE,
        ),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      await expect(
        service.uploadPhoto('c1', undefined, null, CLIENTE),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('el enlace a la foto de un reclamo sin foto es kind none, no 404', async () => {
      claims.findOne.mockResolvedValue(reclamo({ photoUrl: null }));
      await expect(service.getPhotoLink('c1', null, CLIENTE)).resolves.toEqual({
        kind: 'none',
      });
      expect(storage.getSignedDownload).not.toHaveBeenCalled();
    });

    it.each([null, 'https://externa/foto.jpg', 'javascript:alert(1)'])(
      'sin photoKey la photoUrl legada (%s) no se sirve: enlace none y archivo 404',
      async (viejo) => {
        claims.findOne.mockResolvedValue(reclamo({ photoUrl: viejo }));
        await expect(
          service.getPhotoLink('c1', null, CLIENTE),
        ).resolves.toEqual({ kind: 'none' });
        await expect(
          service.getPhotoFile('c1', null, CLIENTE),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(storage.getSignedDownload).not.toHaveBeenCalled();
      },
    );

    it('el enlace a la foto de un reclamo ajeno sigue siendo 404', async () => {
      claims.findOne.mockResolvedValue(null);
      await expect(
        service.getPhotoLink('c1', null, CLIENTE),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('la foto misma de un reclamo sin foto es 404', async () => {
      claims.findOne.mockResolvedValue(reclamo({ photoUrl: null }));
      await expect(
        service.getPhotoFile('c1', null, CLIENTE),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ver la foto devuelve la URL firmada del storage', async () => {
      claims.findOne.mockResolvedValue(reclamo({ photoKey: 'claims/k.png' }));
      const firmada = { url: 'https://s3/firmada', expiresAt: new Date() };
      storage.getSignedDownload.mockResolvedValue(firmada);
      await expect(service.getPhotoLink('c1', null, CLIENTE)).resolves.toEqual({
        kind: 'stored',
        signed: firmada,
      });
      expect(storage.getSignedDownload).toHaveBeenCalledWith('claims/k.png');
    });

    it('photoUrlFor: sin foto es null, y un fallo de la firma no rompe', async () => {
      await expect(service.photoUrlFor(reclamo())).resolves.toBeNull();
      storage.getSignedDownload.mockRejectedValueOnce(new Error('sdk'));
      await expect(
        service.photoUrlFor(reclamo({ photoKey: 'k.png' })),
      ).resolves.toBeNull();
    });
  });
});
