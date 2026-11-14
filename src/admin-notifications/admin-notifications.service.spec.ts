import { NotFoundException } from '@nestjs/common';
import { IsNull, Repository } from 'typeorm';
import { NotificarAdminEvent } from '../common/events/notificar-admin.event';
import { AdminNotificationsService } from './admin-notifications.service';
import { AdminNotification } from './entities/admin-notification.entity';
import { AdminNotificationRead } from './entities/admin-notification-read.entity';

const DUPLICADO = Object.assign(new Error('duplicate key'), { code: '23505' });

function evento(
  parcial: Partial<NotificarAdminEvent> = {},
): NotificarAdminEvent {
  return Object.assign(
    new NotificarAdminEvent(
      'd1',
      'claim_created',
      'Nuevo reclamo',
      'Cuerpo',
      { entity: 'claim', id: 'c-1' },
      false,
      'claim:c-1',
    ),
    parcial,
  );
}

function fila(
  id: string,
  createdAt = '2026-10-28T12:00:00Z',
): AdminNotification {
  return {
    notificationId: id,
    distributorId: 'd1',
    kind: 'claim_created',
    title: 'Nuevo reclamo',
    body: 'Cuerpo',
    linkEntity: 'claim',
    linkId: 'c-1',
    dedupeKey: `claim:${id}`,
    email: false,
    emailedAt: null,
    createdAt: new Date(createdAt),
  };
}

/** QueryBuilder simulado: encadena y registra los `where`. */
function qbFalso(opciones: {
  getMany?: unknown[];
  getManyAndCount?: [unknown[], number];
  getOne?: unknown;
  getCount?: number;
}) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'where',
    'andWhere',
    'select',
    'orderBy',
    'addOrderBy',
    'take',
    'skip',
  ]) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(opciones.getMany ?? []);
  qb.getManyAndCount = jest
    .fn()
    .mockResolvedValue(opciones.getManyAndCount ?? [[], 0]);
  qb.getOne = jest.fn().mockResolvedValue(opciones.getOne ?? null);
  qb.getCount = jest.fn().mockResolvedValue(opciones.getCount ?? 0);
  return qb;
}

describe('AdminNotificationsService', () => {
  let avisos: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let lecturas: {
    find: jest.Mock;
    findOneBy: jest.Mock;
    findOneByOrFail: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    insert: jest.Mock;
  };
  let service: AdminNotificationsService;

  beforeEach(() => {
    avisos = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((x: Partial<AdminNotification>) => x),
      save: jest.fn((x: Partial<AdminNotification>) =>
        Promise.resolve({ ...x, notificationId: 'n-1' }),
      ),
      createQueryBuilder: jest.fn(),
    };
    lecturas = {
      find: jest.fn().mockResolvedValue([]),
      findOneBy: jest.fn().mockResolvedValue(null),
      findOneByOrFail: jest.fn(),
      create: jest.fn((x: Partial<AdminNotificationRead>) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      insert: jest.fn().mockResolvedValue({}),
    };
    service = new AdminNotificationsService(
      avisos as unknown as Repository<AdminNotification>,
      lecturas as unknown as Repository<AdminNotificationRead>,
    );
  });

  describe('registrar', () => {
    it('guarda el aviso con save (así lo audita la base) y devuelve la fila', async () => {
      const guardado = await service.registrar(evento());

      expect(avisos.save).toHaveBeenCalledWith(
        expect.objectContaining({
          distributorId: 'd1',
          kind: 'claim_created',
          linkEntity: 'claim',
          linkId: 'c-1',
          dedupeKey: 'claim:c-1',
          email: false,
        }),
      );
      expect(guardado?.notificationId).toBe('n-1');
    });

    it('si esa distribuidora ya tiene la dedupeKey, no guarda y devuelve null', async () => {
      avisos.findOne.mockResolvedValue({ notificationId: 'previo' });

      expect(await service.registrar(evento())).toBeNull();
      expect(avisos.save).not.toHaveBeenCalled();
    });

    it('la búsqueda del repetido es por distribuidora y clave', async () => {
      await service.registrar(evento());

      expect(avisos.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { distributorId: 'd1', dedupeKey: 'claim:c-1' },
        }),
      );
    });

    it('un aviso de la plataforma (sin distribuidora) busca el repetido con IS NULL, no en todas las empresas', async () => {
      await service.registrar(evento({ distributorId: null }));

      expect(avisos.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { distributorId: IsNull(), dedupeKey: 'claim:c-1' },
        }),
      );
      expect(avisos.create).toHaveBeenCalledWith(
        expect.objectContaining({ distributorId: null }),
      );
    });

    it('si dos emisores chocan en el único de la base (23505), el segundo es un repetido', async () => {
      avisos.save.mockRejectedValue(DUPLICADO);

      expect(await service.registrar(evento())).toBeNull();
    });

    it('otro error de la base se propaga', async () => {
      avisos.save.mockRejectedValue(new Error('base caída'));

      await expect(service.registrar(evento())).rejects.toThrow('base caída');
    });

    it('sin destino guarda los dos campos del link en null', async () => {
      await service.registrar(evento({ link: null }));

      expect(avisos.save).toHaveBeenCalledWith(
        expect.objectContaining({ linkEntity: null, linkId: null }),
      );
    });

    it('recorta el título a la columna', async () => {
      await service.registrar(evento({ title: 'x'.repeat(300) }));

      const [guardado] = avisos.save.mock.calls[0] as [AdminNotification];
      expect(guardado.title).toHaveLength(160);
    });
  });

  describe('marcarCorreoEnviado', () => {
    it('guarda emailedAt con save', async () => {
      const a = fila('n-1');
      await service.marcarCorreoEnviado(a);

      expect(avisos.save).toHaveBeenCalledWith(
        expect.objectContaining({ emailedAt: expect.any(Date) as unknown }),
      );
    });
  });

  describe('listar', () => {
    it('acota a la distribuidora y devuelve el readAt de quien consulta', async () => {
      const leidoEn = new Date('2026-10-28T13:00:00Z');
      const qb = qbFalso({
        getManyAndCount: [[fila('n-1'), fila('n-2')], 2],
      });
      avisos.createQueryBuilder.mockReturnValue(qb);
      lecturas.find.mockResolvedValue([
        { notificationId: 'n-1', userId: 'u1', readAt: leidoEn },
      ]);

      const res = await service.listar('u1', 'd1', {
        limit: 20,
        offset: 0,
      });

      expect(qb.where).toHaveBeenCalledWith(
        'n.distributorId = :distributorId',
        {
          distributorId: 'd1',
        },
      );
      expect(res.total).toBe(2);
      expect(res.items.map((i) => [i.id, i.readAt])).toEqual([
        ['n-1', leidoEn],
        ['n-2', null],
      ]);
      expect(res.items[0].link).toEqual({ entity: 'claim', id: 'c-1' });
    });

    it('las lecturas que se piden son las del usuario que consulta', async () => {
      avisos.createQueryBuilder.mockReturnValue(
        qbFalso({ getManyAndCount: [[fila('n-1')], 1] }),
      );

      await service.listar('u-otro', 'd1', { limit: 20, offset: 0 });

      expect(lecturas.find).toHaveBeenCalledWith({
        where: expect.objectContaining({ userId: 'u-otro' }) as unknown,
      });
    });

    it('el super admin fuera de soporte ve la bandeja de plataforma: nunca la de una empresa', async () => {
      const qb = qbFalso({});
      avisos.createQueryBuilder.mockReturnValue(qb);

      await service.listar('u1', null, { limit: 20, offset: 0 });

      expect(qb.where).toHaveBeenCalledWith('n.distributorId IS NULL');
    });

    it('unread=true filtra los que el usuario no leyó; unread=false, los que sí', async () => {
      const sinLeer = qbFalso({});
      avisos.createQueryBuilder.mockReturnValueOnce(sinLeer);
      await service.listar('u1', 'd1', { unread: true, limit: 20, offset: 0 });
      const leidos = qbFalso({});
      avisos.createQueryBuilder.mockReturnValueOnce(leidos);
      await service.listar('u1', 'd1', { unread: false, limit: 20, offset: 0 });

      expect(sinLeer.andWhere).toHaveBeenCalledWith(
        expect.stringMatching(/^NOT EXISTS/),
        { userId: 'u1' },
      );
      expect(leidos.andWhere).toHaveBeenCalledWith(
        expect.stringMatching(/^EXISTS/),
        { userId: 'u1' },
      );
    });

    it('los más nuevos primero y con la paginación pedida', async () => {
      const qb = qbFalso({});
      avisos.createQueryBuilder.mockReturnValue(qb);

      await service.listar('u1', 'd1', { limit: 5, offset: 10 });

      expect(qb.orderBy).toHaveBeenCalledWith('n.createdAt', 'DESC');
      expect(qb.take).toHaveBeenCalledWith(5);
      expect(qb.skip).toHaveBeenCalledWith(10);
    });

    it('sin resultados no consulta lecturas', async () => {
      avisos.createQueryBuilder.mockReturnValue(qbFalso({}));

      await service.listar('u1', 'd1', { limit: 20, offset: 0 });

      expect(lecturas.find).not.toHaveBeenCalled();
    });
  });

  describe('contarSinLeer', () => {
    it('cuenta los de su alcance que ese usuario no leyó', async () => {
      const qb = qbFalso({ getCount: 3 });
      avisos.createQueryBuilder.mockReturnValue(qb);

      expect(await service.contarSinLeer('u1', 'd1')).toEqual({ count: 3 });
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringMatching(/^NOT EXISTS/),
        { userId: 'u1' },
      );
    });
  });

  describe('marcarLeido', () => {
    it('un aviso de otra distribuidora (o inexistente) es 404 y no marca nada', async () => {
      const qb = qbFalso({ getOne: null });
      avisos.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.marcarLeido('u1', 'd2', 'n-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(qb.where).toHaveBeenCalledWith(
        'n.distributorId = :distributorId',
        {
          distributorId: 'd2',
        },
      );
      expect(lecturas.save).not.toHaveBeenCalled();
    });

    it('guarda la lectura de ESE usuario con save', async () => {
      avisos.createQueryBuilder.mockReturnValue(
        qbFalso({ getOne: fila('n-1') }),
      );

      const res = await service.marcarLeido('u1', 'd1', 'n-1');

      expect(lecturas.save).toHaveBeenCalledWith(
        expect.objectContaining({ notificationId: 'n-1', userId: 'u1' }),
      );
      expect(res.readAt).toBeInstanceOf(Date);
    });

    it('es idempotente: si ya estaba leído devuelve la fecha original sin guardar', async () => {
      const original = new Date('2026-10-28T10:00:00Z');
      avisos.createQueryBuilder.mockReturnValue(
        qbFalso({ getOne: fila('n-1') }),
      );
      lecturas.findOneBy.mockResolvedValue({ readAt: original });

      const res = await service.marcarLeido('u1', 'd1', 'n-1');

      expect(res.readAt).toBe(original);
      expect(lecturas.save).not.toHaveBeenCalled();
    });

    it('si otra solicitud lo marcó al mismo tiempo (23505), devuelve esa lectura', async () => {
      const otra = new Date('2026-10-28T10:00:00Z');
      avisos.createQueryBuilder.mockReturnValue(
        qbFalso({ getOne: fila('n-1') }),
      );
      lecturas.save.mockRejectedValue(DUPLICADO);
      lecturas.findOneByOrFail.mockResolvedValue({ readAt: otra });

      expect((await service.marcarLeido('u1', 'd1', 'n-1')).readAt).toBe(otra);
    });
  });

  describe('marcarTodosLeidos', () => {
    it('marca sólo los pendientes de su alcance, para su usuario', async () => {
      const qb = qbFalso({
        getMany: [fila('n-1'), fila('n-2')],
      });
      avisos.createQueryBuilder.mockReturnValue(qb);

      const res = await service.marcarTodosLeidos('u1', 'd1');

      expect(res).toEqual({ updated: 2 });
      expect(qb.where).toHaveBeenCalledWith(
        'n.distributorId = :distributorId',
        {
          distributorId: 'd1',
        },
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringMatching(/^NOT EXISTS/),
        { userId: 'u1' },
      );
      const guardadas = lecturas.insert.mock.calls.map(
        ([l]) => l as AdminNotificationRead,
      );
      expect(guardadas.map((l) => [l.notificationId, l.userId])).toEqual([
        ['n-1', 'u1'],
        ['n-2', 'u1'],
      ]);
      // Siempre INSERT: nunca reescribe la fecha de una lectura que ya existía.
      expect(lecturas.save).not.toHaveBeenCalled();
    });

    it('sin pendientes devuelve 0 y no guarda', async () => {
      avisos.createQueryBuilder.mockReturnValue(qbFalso({ getMany: [] }));

      expect(await service.marcarTodosLeidos('u1', 'd1')).toEqual({
        updated: 0,
      });
      expect(lecturas.insert).not.toHaveBeenCalled();
    });

    it('si otra solicitud ya marcó uno (23505), se saltea ése y marca los demás', async () => {
      avisos.createQueryBuilder.mockReturnValue(
        qbFalso({ getMany: [fila('n-1'), fila('n-2'), fila('n-3')] }),
      );
      lecturas.insert
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(DUPLICADO)
        .mockResolvedValueOnce({});

      expect(await service.marcarTodosLeidos('u1', 'd1')).toEqual({
        updated: 2,
      });
      expect(lecturas.insert).toHaveBeenCalledTimes(3);
    });

    it('si el único que quedaba ya lo marcó otra solicitud, no suma nada', async () => {
      avisos.createQueryBuilder.mockReturnValue(
        qbFalso({ getMany: [fila('n-1')] }),
      );
      lecturas.insert.mockRejectedValue(DUPLICADO);

      expect(await service.marcarTodosLeidos('u1', 'd1')).toEqual({
        updated: 0,
      });
    });

    it('otro error de la base se propaga', async () => {
      avisos.createQueryBuilder.mockReturnValue(
        qbFalso({ getMany: [fila('n-1')] }),
      );
      lecturas.insert.mockRejectedValue(new Error('se cayó la base'));
      await expect(service.marcarTodosLeidos('u1', 'd1')).rejects.toThrow(
        'se cayó la base',
      );
    });
  });
});
