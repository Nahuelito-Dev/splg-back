import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { EVENTO_NOTIFICAR_ADMIN } from '../common/events/notificar-admin.event';
import { DistributorService } from './distributor.service';
import { Distributor, DistributorStatus } from './entities/distributor.entity';
import { EVENTO_DISTRIBUIDORA_CREADA } from './events/distribuidora-creada.event';

/**
 * La distribuidora es el tenant: el slug no se repite, una suspendida no
 * recibe pedidos, y los clientes viejos sin cabecera caen en la de por defecto.
 */
describe('DistributorService', () => {
  let service: DistributorService;
  let repo: {
    findOne: jest.Mock;
    findAndCount: jest.Mock;
    query: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let eventos: { emit: jest.Mock };

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      query: jest.fn().mockResolvedValue([
        {
          sin_admins_ajenos: true,
          sin_clientes_ajenos: true,
          sin_pedidos: true,
        },
      ]),
      create: jest.fn((d: Partial<Distributor>) => d),
      save: jest.fn((d: Distributor) => Promise.resolve(d)),
    };
    eventos = { emit: jest.fn() };
    service = new DistributorService(
      repo as unknown as Repository<Distributor>,
      { get: (_k: string, def: string) => def } as unknown as ConfigService,
      eventos as unknown as EventEmitter2,
    );
  });

  it('al crear se avisa con un evento, para quien siembre datos base', async () => {
    repo.findOne.mockResolvedValue(null);
    const creada = await service.create({ name: 'Nueva', slug: 'nueva' });
    expect(eventos.emit).toHaveBeenCalledWith(
      EVENTO_DISTRIBUIDORA_CREADA,
      expect.objectContaining({ distributorId: creada.distributorId }),
    );
  });

  it('no se repite el slug', async () => {
    repo.findOne.mockResolvedValue({ slug: 'demo' });
    await expect(
      service.create({ name: 'Otra', slug: 'demo' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('una distribuidora suspendida no está disponible', async () => {
    repo.findOne.mockResolvedValue({
      name: 'X',
      status: DistributorStatus.SUSPENDED,
    });
    await expect(service.assertActive('d1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('la de por defecto sale del slug configurado', async () => {
    repo.findOne.mockResolvedValue({ slug: 'demo' });
    await service.getDefault();
    expect(repo.findOne).toHaveBeenCalledWith({ where: { slug: 'demo' } });
  });

  it('sin la de por defecto, cae en la activa más antigua', async () => {
    repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      slug: 'otra',
    });
    await expect(service.getDefault()).resolves.toMatchObject({
      slug: 'otra',
    });
  });

  describe('empresa propia de la plataforma', () => {
    const ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

    it('por slug: sólo una vigente con la marca', async () => {
      repo.findOne.mockResolvedValue({ distributorId: ID });
      await expect(
        service.empresaPropiaVigente(' prueba-orixtech '),
      ).resolves.toBe(ID);
      expect(repo.findOne).toHaveBeenCalledWith({
        select: { distributorId: true },
        where: {
          slug: 'prueba-orixtech',
          ownedByPlatform: true,
          createdByPlatform: true,
          status: DistributorStatus.ACTIVE,
        },
      });
    });

    it('por uuid: busca por id, con la misma marca y estado', async () => {
      repo.findOne.mockResolvedValue({ distributorId: ID });
      await expect(service.empresaPropiaVigente(ID)).resolves.toBe(ID);
      expect(repo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            distributorId: ID,
            ownedByPlatform: true,
            createdByPlatform: true,
            status: DistributorStatus.ACTIVE,
          },
        }),
      );
    });

    it('una que no es propia (o no existe, o está suspendida) da null', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.empresaPropiaVigente('gas-andino')).resolves.toBe(
        null,
      );
    });

    it.each([
      ['un admin real', 'sin_admins_ajenos'],
      ['un cliente real', 'sin_clientes_ajenos'],
      ['un pedido de un cliente real', 'sin_pedidos'],
    ])(
      'con %s el acceso directo se corta en la request siguiente',
      async (_caso, condicion) => {
        repo.findOne.mockResolvedValue({ distributorId: ID });
        repo.query.mockResolvedValue([
          {
            sin_admins_ajenos: true,
            sin_clientes_ajenos: true,
            sin_pedidos: true,
            [condicion]: false,
          },
        ]);
        await expect(service.empresaPropiaVigente(ID)).resolves.toBe(null);
      },
    );

    it('en cada request sólo cuentan los pedidos de cuentas reales; al marcar, todos', async () => {
      repo.findOne.mockResolvedValue({ distributorId: ID });
      await service.empresaPropiaVigente(ID);
      expect(repo.query).toHaveBeenLastCalledWith(expect.any(String), [
        ID,
        false,
      ]);
      repo.findOne.mockResolvedValue({
        distributorId: ID,
        ownedByPlatform: false,
        createdByPlatform: true,
      });
      await service.marcarPropia(ID, true);
      expect(repo.query).toHaveBeenLastCalledWith(expect.any(String), [
        ID,
        true,
      ]);
    });

    it('un header vacío ni consulta', async () => {
      await expect(service.empresaPropiaVigente('  ')).resolves.toBe(null);
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('marcar una prueba de plataforma: guarda y avisa a sus admins', async () => {
      repo.findOne.mockResolvedValue({
        distributorId: ID,
        ownedByPlatform: false,
        createdByPlatform: true,
      });
      await expect(service.marcarPropia(ID, true)).resolves.toMatchObject({
        ownedByPlatform: true,
      });
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ distributorId: ID, ownedByPlatform: true }),
      );
      expect(eventos.emit).toHaveBeenCalledWith(
        EVENTO_NOTIFICAR_ADMIN,
        expect.objectContaining({ distributorId: ID }),
      );
    });

    const rechazos: Array<{
      caso: string;
      createdByPlatform: boolean;
      elegible?: {
        sin_admins_ajenos: boolean;
        sin_clientes_ajenos: boolean;
        sin_pedidos: boolean;
      };
    }> = [
      { caso: 'no fue creada por la plataforma', createdByPlatform: false },
      {
        caso: 'tiene un admin ajeno',
        createdByPlatform: true,
        elegible: {
          sin_admins_ajenos: false,
          sin_clientes_ajenos: true,
          sin_pedidos: true,
        },
      },
      {
        caso: 'tiene un cliente ajeno',
        createdByPlatform: true,
        elegible: {
          sin_admins_ajenos: true,
          sin_clientes_ajenos: false,
          sin_pedidos: true,
        },
      },
      {
        caso: 'tiene pedidos',
        createdByPlatform: true,
        elegible: {
          sin_admins_ajenos: true,
          sin_clientes_ajenos: true,
          sin_pedidos: false,
        },
      },
    ];
    it.each(rechazos)('no marca si $caso', async (datos) => {
      repo.findOne.mockResolvedValueOnce({
        distributorId: ID,
        ownedByPlatform: false,
        createdByPlatform: datos.createdByPlatform,
      });
      if (datos.createdByPlatform) {
        repo.findOne.mockResolvedValueOnce({ distributorId: ID });
        repo.query.mockResolvedValueOnce([datos.elegible!]);
      }
      await expect(service.marcarPropia(ID, true)).rejects.toMatchObject({
        response: { statusCode: 409, code: 'COMPANY_NOT_PLATFORM_OWNED' },
      });
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('marcar con el mismo valor no escribe (idempotente)', async () => {
      repo.findOne.mockResolvedValue({
        distributorId: ID,
        ownedByPlatform: true,
        createdByPlatform: true,
      });
      await expect(service.marcarPropia(ID, true)).resolves.toMatchObject({
        ownedByPlatform: true,
      });
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('marcar una que no existe o está dada de baja: 404 COMPANY_NOT_FOUND', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.marcarPropia(ID, true)).rejects.toMatchObject({
        response: { statusCode: 404, code: 'COMPANY_NOT_FOUND' },
      });
    });

    it('desmarcar siempre está permitido, aunque ya tenga datos reales', async () => {
      repo.findOne.mockResolvedValue({
        distributorId: ID,
        ownedByPlatform: true,
        createdByPlatform: false,
      });
      await expect(service.marcarPropia(ID, false)).resolves.toMatchObject({
        ownedByPlatform: false,
      });
      expect(repo.query).not.toHaveBeenCalled();
      expect(eventos.emit).toHaveBeenCalledWith(
        EVENTO_NOTIFICAR_ADMIN,
        expect.objectContaining({ distributorId: ID }),
      );
    });
  });
});
