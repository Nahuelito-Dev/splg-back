import { ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PaymentMethod } from '../order/entities/order.entity';
import {
  RepurchaseEstimateSource,
  RepurchaseInvitation,
  RepurchaseInvitationStatus as Estado,
} from './entities/repurchase-invitation.entity';
import {
  NuevaInvitacion,
  RepurchaseInvitationService,
} from './repurchase-invitation.service';

const AHORA = new Date('2026-10-31T12:00:00Z');

const invitacion = (
  parcial: Partial<RepurchaseInvitation> = {},
): RepurchaseInvitation =>
  ({
    invitationId: 'i1',
    distributorId: 'd1',
    userId: 'u1',
    status: Estado.PENDING,
    expiresAt: new Date(AHORA.getTime() + 3_600_000),
    createdAt: new Date(AHORA.getTime() - 3_600_000),
    ...parcial,
  }) as RepurchaseInvitation;

/** Un query builder que registra cada llamada y devuelve lo que se le pida al final. */
function fakeQb(resultados: {
  getRawMany?: unknown;
  getRawOne?: unknown;
  getManyAndCount?: unknown;
  execute?: unknown;
}) {
  const llamadas: Array<[string, unknown[]]> = [];
  const qb: Record<string, jest.Mock> = {};
  for (const metodo of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'update',
    'set',
    'returning',
    'groupBy',
    'innerJoin',
    'leftJoinAndSelect',
    'orderBy',
    'addOrderBy',
    'take',
    'skip',
  ]) {
    qb[metodo] = jest.fn().mockImplementation((...args: unknown[]) => {
      llamadas.push([metodo, args]);
      return qb;
    });
  }
  for (const [metodo, valor] of Object.entries(resultados)) {
    qb[metodo] = jest.fn().mockResolvedValue(valor);
  }
  return { qb, llamadas };
}

describe('RepurchaseInvitationService', () => {
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    findOneOrFail: jest.Mock;
    createQueryBuilder: jest.Mock;
    query: jest.Mock;
  };
  let service: RepurchaseInvitationService;

  beforeEach(() => {
    repo = {
      create: jest.fn().mockImplementation((d: object) => ({ ...d })),
      save: jest.fn().mockImplementation((e: object) => Promise.resolve(e)),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      findOneOrFail: jest.fn(),
      createQueryBuilder: jest.fn(),
      query: jest.fn(),
    };
    service = new RepurchaseInvitationService(
      repo as unknown as Repository<RepurchaseInvitation>,
    );
  });

  describe('abrir', () => {
    const datos: NuevaInvitacion = {
      distributorId: 'd1',
      userId: 'u1',
      addressId: 'a1',
      timeSlotId: null,
      paymentMethod: PaymentMethod.CASH,
      projectedDepletionAt: AHORA,
      estimateKgPerDay: 0.25,
      estimateOrdersUsed: 4,
      estimateSource: RepurchaseEstimateSource.HISTORY,
      suggestedItems: [{ gasCylinderId: 'g', quantity: 1 }],
      expiresAt: AHORA,
      offsetDays: 0,
      notifyAt: AHORA,
    };

    it('guarda la invitación', async () => {
      expect(await service.abrir(datos)).toMatchObject({ userId: 'u1' });
      expect(repo.save).toHaveBeenCalled();
    });

    it('si el cliente ya tiene una abierta (otra corrida se adelantó) devuelve null', async () => {
      repo.save.mockRejectedValue({ code: '23505' });
      expect(await service.abrir(datos)).toBeNull();
    });

    it('cualquier otro error se propaga', async () => {
      repo.save.mockRejectedValue(new Error('base caída'));
      await expect(service.abrir(datos)).rejects.toThrow('base caída');
    });
  });

  it('ultimasPorCliente: la invitación más nueva de cada cliente', async () => {
    repo.find.mockResolvedValue([
      invitacion({ invitationId: 'nueva', userId: 'u1' }),
      invitacion({ invitationId: 'vieja', userId: 'u1' }),
      invitacion({ invitationId: 'otra', userId: 'u2' }),
    ]);
    const r = await service.ultimasPorCliente('d1', AHORA);
    expect([...r.entries()].map(([u, i]) => [u, i.invitationId])).toEqual([
      ['u1', 'nueva'],
      ['u2', 'otra'],
    ]);
    const [consulta] = repo.find.mock.calls[0] as [
      { where: object; order: object },
    ];
    expect(consulta.where).toMatchObject({ distributorId: 'd1' });
    expect(consulta.order).toEqual({ createdAt: 'DESC' });
  });

  describe('vencerVencidas', () => {
    it('sin vencidas no escribe', async () => {
      expect(await service.vencerVencidas(AHORA)).toEqual([]);
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('cierra las vencidas y devuelve sólo las que cerró en esta sentencia', async () => {
      repo.find.mockResolvedValue([
        invitacion({ invitationId: 'i1' }),
        invitacion({ invitationId: 'i2' }),
      ]);
      const { qb, llamadas } = fakeQb({
        execute: { raw: [{ invitation_id: 'i2' }] },
      });
      repo.createQueryBuilder.mockReturnValue(qb);

      const r = await service.vencerVencidas(AHORA, 'd1');

      expect(r.map((i) => i.invitationId)).toEqual(['i2']);
      expect(llamadas).toContainEqual([
        'set',
        [{ status: Estado.EXPIRED, respondedAt: AHORA }],
      ]);
      expect(llamadas).toContainEqual([
        'andWhere',
        ['status = :abierta', { abierta: Estado.PENDING }],
      ]);
      const [consulta] = repo.find.mock.calls[0] as [{ where: object }];
      expect(consulta.where).toMatchObject({
        status: Estado.PENDING,
        distributorId: 'd1',
      });
    });
  });

  it('abiertas: las pendientes de una distribuidora o de todas', async () => {
    await service.abiertas('d1');
    await service.abiertas();
    expect(repo.find).toHaveBeenNthCalledWith(1, {
      where: { status: Estado.PENDING, distributorId: 'd1' },
    });
    expect(repo.find).toHaveBeenNthCalledWith(2, {
      where: { status: Estado.PENDING },
    });
  });

  describe('delCliente', () => {
    it('devuelve la invitación del cliente', async () => {
      repo.findOne.mockResolvedValue(invitacion());
      expect((await service.delCliente('i1', 'u1')).invitationId).toBe('i1');
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { invitationId: 'i1', userId: 'u1' },
      });
    });

    it('la de otro cliente es un 404', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.delCliente('i1', 'otro')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listarDelCliente', () => {
    it('todas las del cliente, la más nueva primero', async () => {
      await service.listarDelCliente('u1', {});
      expect(repo.find).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        order: { createdAt: 'DESC' },
        take: 50,
      });
    });

    it('sólo las abiertas y vigentes de una distribuidora', async () => {
      await service.listarDelCliente('u1', {
        distributorId: 'd1',
        abiertasA: AHORA,
      });
      const donde = (repo.find.mock.calls[0] as [{ where: object }])[0].where;
      expect(donde).toMatchObject({
        userId: 'u1',
        distributorId: 'd1',
        status: Estado.PENDING,
      });
      expect(donde).toHaveProperty('expiresAt');
    });
  });

  describe('descartar', () => {
    it('cierra la abierta como descartada', async () => {
      repo.findOne.mockResolvedValue(invitacion());
      const { qb, llamadas } = fakeQb({ execute: { affected: 1 } });
      repo.createQueryBuilder.mockReturnValue(qb);
      repo.findOneOrFail.mockResolvedValue(
        invitacion({ status: Estado.REJECTED }),
      );

      const r = await service.descartar('i1', 'u1', AHORA);

      expect(r.status).toBe(Estado.REJECTED);
      expect(llamadas).toContainEqual([
        'set',
        [{ status: Estado.REJECTED, respondedAt: AHORA }],
      ]);
    });

    it.each([
      [Estado.ACCEPTED, 'ya fue aceptada'],
      [Estado.REJECTED, 'ya fue descartada'],
      [Estado.EXPIRED, 'venció'],
      [Estado.CANCELLED, 'ya hiciste un pedido'],
    ])('si ya está %s responde 409 con el motivo', async (estado, texto) => {
      repo.findOne.mockResolvedValue(invitacion({ status: estado }));
      const { qb } = fakeQb({ execute: { affected: 0 } });
      repo.createQueryBuilder.mockReturnValue(qb);
      repo.findOneOrFail.mockResolvedValue(invitacion({ status: estado }));

      const intento = service.descartar('i1', 'u1', AHORA);

      await expect(intento).rejects.toThrow(ConflictException);
      await expect(intento).rejects.toThrow(texto);
    });
  });

  describe('aviso en la franja (M3b)', () => {
    it('reclamarAviso: una sentencia condicionada a abierta, sin avisar, con la hora cumplida y vigente', async () => {
      const { qb, llamadas } = fakeQb({ execute: { affected: 1 } });
      repo.createQueryBuilder.mockReturnValue(qb);
      expect(await service.reclamarAviso('i1', AHORA)).toBe(true);
      expect(llamadas).toContainEqual(['set', [{ notifiedAt: AHORA }]]);
      expect(llamadas).toContainEqual([
        'andWhere',
        ['status = :abierta', { abierta: Estado.PENDING }],
      ]);
      expect(llamadas).toContainEqual(['andWhere', ['notified_at IS NULL']]);
      expect(llamadas).toContainEqual([
        'andWhere',
        ['notify_at <= :ahora AND expires_at > :ahora', { ahora: AHORA }],
      ]);
    });

    it('reclamarAviso: si otra ya la reclamó (o no está en hora) devuelve false', async () => {
      const { qb } = fakeQb({ execute: { affected: 0 } });
      repo.createQueryBuilder.mockReturnValue(qb);
      expect(await service.reclamarAviso('i1', AHORA)).toBe(false);
    });

    it('paraAvisar: abiertas, sin avisar, en hora y vigentes', async () => {
      repo.find.mockResolvedValue([invitacion()]);
      await service.paraAvisar(AHORA, 'd1');
      const [consulta] = repo.find.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(consulta.where).toMatchObject({
        status: Estado.PENDING,
        distributorId: 'd1',
      });
      expect(Object.keys(consulta.where)).toEqual(
        expect.arrayContaining(['notifiedAt', 'notifyAt', 'expiresAt']),
      );
    });

    it('erroresDelCliente: error de cada invitación medida contra su fecha base', async () => {
      const dia = 86_400_000;
      repo.query.mockResolvedValue([
        // Predicha +3 días con un ajuste de +2: la base era +1; compró en +4: error 3.
        {
          predicha: new Date(AHORA.getTime() + 3 * dia),
          offset_days: 2,
          real: new Date(AHORA.getTime() + 4 * dia),
        },
        // Sin compra posterior: no cuenta.
        { predicha: AHORA, offset_days: 0, real: null },
        // Sin ajuste: compró 2 días antes.
        {
          predicha: new Date(AHORA.getTime() + 5 * dia),
          offset_days: 0,
          real: new Date(AHORA.getTime() + 3 * dia),
        },
      ]);
      expect(await service.erroresDelCliente('d1', 'u1')).toEqual([3, -2]);
      const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('inv."distributor_id" = $1');
      expect(sql).toContain('inv."user_id" = $2');
      expect(params.slice(0, 2)).toEqual(['d1', 'u1']);
    });
  });

  it('cancelar: cierra sin efecto la abierta y avisa si lo logró', async () => {
    const { qb, llamadas } = fakeQb({ execute: { affected: 1 } });
    repo.createQueryBuilder.mockReturnValue(qb);
    expect(await service.cancelar('i1', AHORA)).toBe(true);
    expect(llamadas).toContainEqual([
      'set',
      [{ status: Estado.CANCELLED, respondedAt: AHORA }],
    ]);
  });

  it('cancelar: si ya no estaba abierta devuelve false', async () => {
    const { qb } = fakeQb({ execute: { affected: undefined } });
    repo.createQueryBuilder.mockReturnValue(qb);
    expect(await service.cancelar('i1', AHORA)).toBe(false);
  });

  it('aceptada: registra el pedido aunque el vencimiento o el cierre se hayan adelantado', async () => {
    const { qb, llamadas } = fakeQb({ execute: { affected: 1 } });
    repo.createQueryBuilder.mockReturnValue(qb);
    repo.findOneOrFail.mockResolvedValue(
      invitacion({ status: Estado.ACCEPTED }),
    );

    const r = await service.aceptada('i1', 'o1', AHORA);

    expect(r.status).toBe(Estado.ACCEPTED);
    expect(llamadas).toContainEqual([
      'set',
      [{ status: Estado.ACCEPTED, respondedAt: AHORA, orderId: 'o1' }],
    ]);
    expect(llamadas).toContainEqual([
      'andWhere',
      ['status != :aceptada', { aceptada: Estado.ACCEPTED }],
    ]);
  });

  it('aceptada: el pedido creado gana aunque la invitación se hubiera descartado en el medio', async () => {
    const { qb, llamadas } = fakeQb({ execute: { affected: 1 } });
    repo.createQueryBuilder.mockReturnValue(qb);
    repo.findOneOrFail.mockResolvedValue(
      invitacion({ status: Estado.ACCEPTED }),
    );
    await service.aceptada('i1', 'o1', AHORA);
    const condiciones = llamadas
      .filter(([m]) => m === 'andWhere')
      .map(([, a]) => a[0]);
    // No se limita a pending/expired/cancelled: cualquier otro estado pasa a aceptada.
    expect(condiciones).toEqual(['status != :aceptada']);
  });

  describe('exigirAbierta', () => {
    it('deja pasar la abierta', () => {
      expect(() => service.exigirAbierta(invitacion())).not.toThrow();
    });

    it('rechaza la que ya se resolvió', () => {
      expect(() =>
        service.exigirAbierta(invitacion({ status: Estado.EXPIRED })),
      ).toThrow(ConflictException);
    });

    it('con un estado sin mensaje propio usa el genérico', () => {
      expect(() =>
        service.exigirAbierta(
          invitacion({ status: 'otro' as unknown as Estado }),
        ),
      ).toThrow('La invitación ya no está abierta');
    });
  });

  describe('listar (administrador)', () => {
    it('acota por la distribuidora y aplica los filtros', async () => {
      const { qb, llamadas } = fakeQb({ getManyAndCount: [[invitacion()], 1] });
      repo.createQueryBuilder.mockReturnValue(qb);
      const desde = new Date('2026-10-01');
      const hasta = new Date('2026-10-31');

      const [lista, total] = await service.listar('d1', {
        status: Estado.ACCEPTED,
        userId: 'u1',
        from: desde,
        to: hasta,
        limit: 5,
        offset: 10,
      });

      expect(total).toBe(1);
      expect(lista).toHaveLength(1);
      expect(llamadas).toContainEqual([
        'where',
        ['inv.distributorId = :distributorId', { distributorId: 'd1' }],
      ]);
      const wheres = llamadas
        .filter(([m]) => m === 'andWhere')
        .map(([, a]) => a[0]);
      expect(wheres).toEqual([
        'inv.status = :status',
        'inv.userId = :userId',
        'inv.createdAt >= :from',
        'inv.createdAt < :to',
      ]);
      expect(llamadas).toContainEqual(['take', [5]]);
      expect(llamadas).toContainEqual(['skip', [10]]);
    });

    it('sin filtros sólo acota por la distribuidora', async () => {
      const { qb, llamadas } = fakeQb({ getManyAndCount: [[], 0] });
      repo.createQueryBuilder.mockReturnValue(qb);
      await service.listar('d1', { limit: 10, offset: 0 });
      expect(llamadas.filter(([m]) => m === 'andWhere')).toHaveLength(0);
    });
  });

  describe('comprasPosteriores', () => {
    it('devuelve predicha y real de las que tuvieron una compra posterior y descarta las demás', async () => {
      repo.query = jest.fn().mockResolvedValue([
        { predicha: '2026-10-10T15:00:00Z', real: '2026-10-12T15:00:00Z' },
        { predicha: '2026-10-10T15:00:00Z', real: null },
      ]);
      const r = await service.comprasPosteriores('d1', AHORA, AHORA);
      expect(r).toEqual([
        {
          predicha: new Date('2026-10-10T15:00:00Z'),
          real: new Date('2026-10-12T15:00:00Z'),
        },
      ]);
      expect(repo.query).toHaveBeenCalledWith(
        expect.stringContaining(`inv."status" <> 'pending'`),
        ['d1', AHORA, AHORA],
      );
    });
  });

  describe('resumen', () => {
    it('cuenta por estado, con cero en los que no hay, y suma lo que vendieron las aceptadas', async () => {
      const cuentas = fakeQb({
        getRawMany: [
          { status: Estado.ACCEPTED, n: '2' },
          { status: Estado.EXPIRED, n: '5' },
        ],
      });
      const ingresos = fakeQb({ getRawOne: { total: '31600.50' } });
      repo.createQueryBuilder
        .mockReturnValueOnce(cuentas.qb)
        .mockReturnValueOnce(ingresos.qb);

      const r = await service.resumen('d1', AHORA, AHORA);

      expect(r.counts).toEqual({
        pending: 0,
        accepted: 2,
        rejected: 0,
        expired: 5,
        cancelled: 0,
      });
      expect(r.acceptedRevenue).toBe(31600.5);
    });

    it('sin aceptadas el ingreso es cero', async () => {
      repo.createQueryBuilder
        .mockReturnValueOnce(fakeQb({ getRawMany: [] }).qb)
        .mockReturnValueOnce(fakeQb({ getRawOne: undefined }).qb);
      expect((await service.resumen('d1', AHORA, AHORA)).acceptedRevenue).toBe(
        0,
      );
    });
  });

  describe('abiertasDe', () => {
    it('sin clientes no consulta', async () => {
      expect((await service.abiertasDe('d1', [])).size).toBe(0);
      expect(repo.find).not.toHaveBeenCalled();
    });

    it('indexa por cliente las abiertas de la distribuidora', async () => {
      repo.find.mockResolvedValue([invitacion({ userId: 'u7' })]);
      const r = await service.abiertasDe('d1', ['u7', 'u8']);
      expect(r.get('u7')?.invitationId).toBe('i1');
      expect(r.has('u8')).toBe(false);
    });
  });
});
