import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RoleType } from '../common/constants/role-type.enum';
import { DispatchSettingsService } from '../distributor/dispatch-settings.service';
import {
  Order,
  OrderDeliveryMode,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../order/entities/order.entity';
import { RoutePlanningCalendarService } from '../route-batch/application/route-planning-calendar.service';
import { DriversGateway } from '../gateways/drivers.gateway';
import { RedisService } from '../redis/redis.service';
import { TimeSlotService } from '../time-slot/time-slot.service';
import {
  DeliveryKind,
  FailedVisitOutcome,
  FailedVisitReason,
  RevisitResolution,
  RevisitStatus,
} from './domain/nueva-visita';
import { OrderFailedVisit } from './entities/order-failed-visit.entity';
import {
  FailedVisitService,
  RevisitError,
  VisitaFallida,
  motivoLegible,
} from './failed-visit.service';

// Sábado 21/11/2026, 10:00 en Argentina.
const AHORA = new Date('2026-11-21T13:00:00Z');
const HOY = '2026-11-21';
const LUNES = '2026-11-23';

const codigo = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'sin error';
  } catch (e) {
    return (e as { getResponse: () => { code?: string } }).getResponse().code;
  }
};

function pedido(o: Partial<Order> = {}): Order {
  return {
    orderId: 'o1',
    distributorId: 'dist',
    customerId: 'cli',
    addressId: 'dir',
    status: OrderStatus.ON_THE_WAY,
    deliveryId: 'chofer-1',
    deliveryMode: OrderDeliveryMode.STANDARD,
    paymentMethod: PaymentMethod.CASH,
    paymentStatus: PaymentStatus.PENDING,
    totalAmount: 15000,
    scheduledDate: null,
    timeSlotId: 'tarde',
    failedVisitCount: 0,
    revisitStatus: null,
    lastFailedVisitAt: null,
    deliveryPoint: { type: 'Point', coordinates: [-55.9, -27.36] },
    ...o,
  } as Order;
}

const visita = (o: Partial<VisitaFallida> = {}): VisitaFallida => ({
  reason: FailedVisitReason.CUSTOMER_ABSENT,
  latitude: -27.3601,
  longitude: -55.9,
  accuracyMeters: 9,
  userId: 'u-chofer',
  role: RoleType.DELIVERY,
  ...o,
});

function armar(
  o: {
    pedido?: Order;
    /** Cupos libres por día y franja (por omisión, 5 en todas). */
    cupos?: Record<string, Record<string, number>>;
    sinFranjas?: boolean;
    ultimaVisita?: Partial<OrderFailedVisit> | null;
    enRecorrido?: boolean;
    franjaLlena?: boolean;
    /** Feriados de la distribuidora. */
    feriados?: string[];
    /** Intentos fallidos de la parada si el pedido está en una hoja en curso. */
    paradaDeHoja?: number;
  } = {},
) {
  const elPedido = o.pedido ?? pedido();
  const manager = {
    createQueryBuilder: jest.fn(() => {
      const qb = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(elPedido),
      };
      return qb;
    }),
    create: jest.fn((_e: unknown, datos: object) => ({ ...datos })),
    save: jest.fn((fila: object) =>
      Promise.resolve({ failedVisitId: 'v-nueva', ...fila }),
    ),
    update: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn((entidad: unknown) =>
      Promise.resolve(
        entidad === OrderFailedVisit ? (o.ultimaVisita ?? null) : elPedido,
      ),
    ),
    find: jest.fn().mockResolvedValue([]),
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('route_batch_stop') ? (o.enRecorrido ? [{}] : []) : [],
      ),
    ),
  };
  const dataSource = {
    manager,
    transaction: jest.fn((fn: (m: unknown) => unknown) => fn(manager)),
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('route_batch_stop')
          ? o.paradaDeHoja === undefined
            ? []
            : [{ intentos: o.paradaDeHoja }]
          : [
              {
                modo: elPedido.deliveryMode,
                cuenta: elPedido.failedVisitCount ?? 0,
              },
            ],
      ),
    ),
  };
  const timeSlots = {
    getAvailability: jest.fn((fecha: string) =>
      Promise.resolve(
        o.sinFranjas
          ? []
          : ['manana', 'tarde'].map((id) => ({
              timeSlotId: id,
              name: id,
              startTime: id === 'manana' ? '09:00:00' : '14:00:00',
              endTime: id === 'manana' ? '13:00:00' : '18:00:00',
              capacity: 10,
              booked: 0,
              remaining: o.cupos?.[fecha]?.[id] ?? 5,
            })),
      ),
    ),
    assertSlotAvailableTx: o.franjaLlena
      ? jest.fn().mockRejectedValue(new BadRequestException('completa'))
      : jest.fn().mockResolvedValue(undefined),
  };
  const calendario = {
    // Lunes a sábado, sin feriados.
    calendario: jest.fn().mockResolvedValue({
      diasHabiles: new Set([1, 2, 3, 4, 5, 6]),
      feriados: new Set<string>(o.feriados ?? []),
    }),
  };
  const settings = {
    obtener: jest.fn().mockResolvedValue({ arrivalRadiusMeters: 100 }),
  };
  // El cerrojo del despacho siempre se obtiene (salvo que el test diga otra cosa).
  const redis = {
    withLock: jest.fn(
      async (_k: string, _ttl: number, fn: () => Promise<unknown>) => ({
        obtenido: true,
        valor: await fn(),
      }),
    ),
  };
  const drivers = { notifyOrderCancelled: jest.fn() };
  const svc = new FailedVisitService(
    dataSource as unknown as DataSource,
    timeSlots as unknown as TimeSlotService,
    calendario as unknown as RoutePlanningCalendarService,
    settings as unknown as DispatchSettingsService,
    redis as unknown as RedisService,
    drivers as unknown as DriversGateway,
  );
  return {
    svc,
    redis,
    drivers,
    manager,
    em: manager as unknown as EntityManager,
    dataSource,
    timeSlots,
    pedido: elPedido,
  };
}

describe('FailedVisitService.registrar (pedido suelto y express)', () => {
  it('pedido suelto: propone el próximo día hábil con la franja original y deja la visita asentada con la ubicación', async () => {
    const t = armar();
    const r = await t.svc.registrar(t.em, t.pedido, visita(), AHORA);

    expect(r).toMatchObject({
      failedVisitCount: 1,
      outcome: FailedVisitOutcome.PROPOSED,
      revisitStatus: RevisitStatus.PROPOSED,
      scheduledDate: LUNES,
      timeSlotId: 'tarde',
    });
    // El domingo no se reparte: no se consulta ni se propone.
    expect(t.timeSlots.getAvailability).toHaveBeenCalledTimes(1);
    expect(t.timeSlots.getAvailability).toHaveBeenCalledWith(LUNES, 'dist');
    expect(t.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'o1',
        distributorId: 'dist',
        visitNumber: 1,
        deliveryKind: DeliveryKind.SINGLE,
        reason: FailedVisitReason.CUSTOMER_ABSENT,
        point: { type: 'Point', coordinates: [-55.9, -27.3601] },
        accuracyM: 9,
        distanceM: 11,
        outOfRange: false,
        reportedByUserId: 'u-chofer',
        reportedByRole: RoleType.DELIVERY,
        deliveryId: 'chofer-1',
        failedAt: AHORA,
        outcome: FailedVisitOutcome.PROPOSED,
        proposedDate: LUNES,
        proposedTimeSlotId: 'tarde',
        agreedWithCustomer: false,
      }),
    );
    expect(t.pedido).toMatchObject({
      failedVisitCount: 1,
      lastFailedVisitAt: AHORA,
      revisitStatus: RevisitStatus.PROPOSED,
      scheduledDate: LUNES,
      timeSlotId: 'tarde',
      transitionReason: 'No se pudo entregar: El cliente no estaba',
    });
  });

  it('no cambia el estado, el stock reservado ni el pago: eso sigue como estaba', async () => {
    const t = armar();
    const antes = { ...t.pedido };
    await t.svc.registrar(t.em, t.pedido, visita(), AHORA);
    expect(t.pedido.status).toBe(antes.status);
    expect(t.pedido.paymentStatus).toBe(antes.paymentStatus);
    expect(t.pedido.paymentMethod).toBe(antes.paymentMethod);
    expect(t.pedido.totalAmount).toBe(antes.totalAmount);
    // Sólo escribe la visita: ni renglones, ni stock, ni pagos.
    expect(t.manager.update).not.toHaveBeenCalled();
    expect(t.manager.save).toHaveBeenCalledTimes(1);
  });

  it('si la franja propuesta se llena al tomarla (otra reserva), propone otra', async () => {
    const t = armar();
    t.timeSlots.assertSlotAvailableTx
      .mockRejectedValueOnce(new BadRequestException('completa'))
      .mockResolvedValue(undefined);
    expect(
      await t.svc.registrar(t.em, t.pedido, visita(), AHORA),
    ).toMatchObject({ scheduledDate: LUNES, timeSlotId: 'manana' });
  });

  it('si todas las franjas que propone se llenan al tomarlas, decide el admin (no reintenta para siempre)', async () => {
    const t = armar({ franjaLlena: true });
    expect(
      (await t.svc.registrar(t.em, t.pedido, visita(), AHORA)).outcome,
    ).toBe(FailedVisitOutcome.AWAITING_ADMIN);
    const hoja = armar({
      franjaLlena: true,
      pedido: pedido({
        status: OrderStatus.PENDING,
        deliveryId: null,
        timeSlotId: null,
      }),
    });
    expect(
      (
        await hoja.svc.registrarDeHoja(
          {
            orderId: 'o1',
            deliveryId: 'chofer-1',
            ...visita(),
            salida: 'rescheduled',
            rescheduledTo: LUNES,
          },
          AHORA,
        )
      )?.outcome,
    ).toBe(FailedVisitOutcome.AWAITING_ADMIN);
  });

  it('respeta el cupo: con la franja original completa propone la primera libre; con el día completo, el siguiente', async () => {
    const llena = armar({ cupos: { [LUNES]: { tarde: 0 } } });
    expect(
      await llena.svc.registrar(llena.em, llena.pedido, visita(), AHORA),
    ).toMatchObject({ scheduledDate: LUNES, timeSlotId: 'manana' });

    const diaLleno = armar({ cupos: { [LUNES]: { manana: 0, tarde: 0 } } });
    expect(
      await diaLleno.svc.registrar(
        diaLleno.em,
        diaLleno.pedido,
        visita(),
        AHORA,
      ),
    ).toMatchObject({ scheduledDate: '2026-11-24', timeSlotId: 'tarde' });
  });

  it('express: lo antes posible, la próxima franja libre de hoy', async () => {
    const t = armar({
      pedido: pedido({
        deliveryMode: OrderDeliveryMode.EXPRESS,
        timeSlotId: null,
      }),
      cupos: { [HOY]: { manana: 0 } },
    });
    const r = await t.svc.registrar(t.em, t.pedido, visita(), AHORA);
    expect(r).toMatchObject({
      outcome: FailedVisitOutcome.PROPOSED,
      scheduledDate: HOY,
      timeSlotId: 'tarde',
    });
    expect(r.visit.deliveryKind).toBe(DeliveryKind.EXPRESS);
  });

  it('express sin franja libre hoy: el próximo día hábil a primera hora', async () => {
    const t = armar({
      pedido: pedido({
        deliveryMode: OrderDeliveryMode.EXPRESS,
        timeSlotId: null,
      }),
      cupos: { [HOY]: { manana: 0, tarde: 0 } },
    });
    expect(
      await t.svc.registrar(t.em, t.pedido, visita(), AHORA),
    ).toMatchObject({ scheduledDate: LUNES, timeSlotId: 'manana' });
  });

  it('express en un feriado (o un día que no se reparte): no propone hoy aunque haya franjas con cupo', async () => {
    const t = armar({
      pedido: pedido({
        deliveryMode: OrderDeliveryMode.EXPRESS,
        timeSlotId: null,
      }),
      feriados: [HOY],
    });
    expect(
      await t.svc.registrar(t.em, t.pedido, visita(), AHORA),
    ).toMatchObject({ scheduledDate: LUNES, timeSlotId: 'manana' });
    expect(t.timeSlots.getAvailability).not.toHaveBeenCalledWith(HOY, 'dist');
  });

  it('una distribuidora sin franjas propone sólo el día; con franjas todas llenas el primer día, busca el siguiente con cupo', async () => {
    const sinFranjas = armar({ sinFranjas: true });
    expect(
      await sinFranjas.svc.registrar(
        sinFranjas.em,
        sinFranjas.pedido,
        visita(),
        AHORA,
      ),
    ).toMatchObject({
      outcome: FailedVisitOutcome.PROPOSED,
      scheduledDate: LUNES,
      timeSlotId: null,
    });
    const llenas = armar({
      cupos: {
        [LUNES]: { manana: 0, tarde: 0 },
        '2026-11-24': { manana: 0, tarde: 0 },
      },
    });
    expect(
      await llenas.svc.registrar(llenas.em, llenas.pedido, visita(), AHORA),
    ).toMatchObject({ scheduledDate: '2026-11-25', timeSlotId: 'tarde' });
  });

  it('N = 2: a la segunda visita fallida decide el admin y el pedido queda sin día ni franja hasta que decida', async () => {
    const t = armar({
      pedido: pedido({
        failedVisitCount: 1,
        scheduledDate: HOY,
        revisitStatus: RevisitStatus.CONFIRMED,
      }),
    });
    const r = await t.svc.registrar(t.em, t.pedido, visita(), AHORA);
    expect(r).toMatchObject({
      failedVisitCount: 2,
      outcome: FailedVisitOutcome.AWAITING_ADMIN,
      revisitStatus: RevisitStatus.AWAITING_ADMIN,
      scheduledDate: null,
      timeSlotId: null,
    });
    expect(t.timeSlots.getAvailability).not.toHaveBeenCalled();
    expect(t.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ visitNumber: 2, proposedDate: null }),
    );
  });

  it('«Acordé con el cliente»: queda confirmada con el día y la franja acordados, validando el cupo', async () => {
    const t = armar();
    const r = await t.svc.registrar(
      t.em,
      t.pedido,
      visita({ agreed: { date: '2026-11-25', timeSlotId: 'manana' } }),
      AHORA,
    );
    expect(r).toMatchObject({
      outcome: FailedVisitOutcome.AGREED,
      revisitStatus: RevisitStatus.CONFIRMED,
      scheduledDate: '2026-11-25',
      timeSlotId: 'manana',
    });
    expect(t.timeSlots.assertSlotAvailableTx).toHaveBeenCalledWith(
      t.em,
      'manana',
      '2026-11-25',
      'dist',
    );
    expect(t.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ agreedWithCustomer: true }),
    );
  });

  it('el acuerdo no vale un domingo (400) ni en una franja sin cupo (409), y no se asienta nada', async () => {
    const domingo = armar();
    expect(
      await codigo(
        domingo.svc.registrar(
          domingo.em,
          domingo.pedido,
          visita({ agreed: { date: '2026-11-22', timeSlotId: 'manana' } }),
          AHORA,
        ),
      ),
    ).toBe(RevisitError.DIA_INVALIDO);
    expect(domingo.manager.save).not.toHaveBeenCalled();

    const llena = armar({ franjaLlena: true });
    expect(
      await codigo(
        llena.svc.registrar(
          llena.em,
          llena.pedido,
          visita({ agreed: { date: LUNES, timeSlotId: 'manana' } }),
          AHORA,
        ),
      ),
    ).toBe(RevisitError.FRANJA_SIN_CUPO);
    expect(llena.manager.save).not.toHaveBeenCalled();
  });

  it('en la segunda visita el acuerdo del chofer queda anotado, pero decide el admin', async () => {
    const t = armar({ pedido: pedido({ failedVisitCount: 1 }) });
    const r = await t.svc.registrar(
      t.em,
      t.pedido,
      visita({ agreed: { date: LUNES, timeSlotId: 'manana' } }),
      AHORA,
    );
    expect(r.outcome).toBe(FailedVisitOutcome.AWAITING_ADMIN);
    expect(t.pedido.scheduledDate).toBeNull();
    expect(t.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        proposedDate: LUNES,
        proposedTimeSlotId: 'manana',
        agreedWithCustomer: true,
      }),
    );
  });

  it('sin lugar en dos semanas: decide el admin', async () => {
    const cupos: Record<string, Record<string, number>> = {};
    for (let i = 1; i <= 14; i++) {
      const d = new Date(`${HOY}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      cupos[d.toISOString().slice(0, 10)] = { manana: 0, tarde: 0 };
    }
    const t = armar({ cupos });
    expect(
      (await t.svc.registrar(t.em, t.pedido, visita(), AHORA)).outcome,
    ).toBe(FailedVisitOutcome.AWAITING_ADMIN);
  });

  it('lejos del domicilio no se rechaza: se marca fuera de radio; un admin informa sin ubicación', async () => {
    const lejos = armar();
    await lejos.svc.registrar(
      lejos.em,
      lejos.pedido,
      visita({ latitude: -27.37, longitude: -55.9 }),
      AHORA,
    );
    expect(lejos.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ outOfRange: true }),
    );

    const admin = armar();
    await admin.svc.registrar(
      admin.em,
      admin.pedido,
      visita({
        latitude: null,
        longitude: null,
        accuracyMeters: null,
        role: RoleType.ADMIN,
        reason: FailedVisitReason.OTHER,
        note: '  llamó el chofer  ',
      }),
      AHORA,
    );
    expect(admin.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        point: null,
        distanceM: null,
        accuracyM: null,
        outOfRange: false,
        note: 'llamó el chofer',
        reportedByRole: RoleType.ADMIN,
      }),
    );
    expect(admin.pedido.transitionReason).toBe(
      'No se pudo entregar: Otro motivo: llamó el chofer',
    );
  });

  it('sin punto de entrega en el pedido mide contra la dirección', async () => {
    const t = armar({ pedido: pedido({ deliveryPoint: null }) });
    t.manager.query.mockResolvedValue([{ lat: -27.36, lng: -55.9 }] as never);
    await t.svc.registrar(t.em, t.pedido, visita(), AHORA);
    expect(t.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ distanceM: 11 }),
    );
  });
});

describe('FailedVisitService: hoja de ruta', () => {
  const deHoja = {
    orderId: 'o1',
    deliveryId: 'chofer-1',
    ...visita(),
  };
  const liberado = () =>
    pedido({
      status: OrderStatus.PENDING,
      deliveryId: null,
      timeSlotId: null,
      scheduledDate: LUNES,
    });

  it('prepararDeHoja: avisa si la próxima visita fallida es la segunda y valida el acuerdo; el primer intento no lee nada', async () => {
    const t = armar();
    expect(
      await t.svc.prepararDeHoja('o1', 'requeued', undefined, AHORA),
    ).toEqual({ alAdmin: false });
    expect(t.manager.createQueryBuilder).not.toHaveBeenCalled();
    expect(
      await t.svc.prepararDeHoja('o1', 'rescheduled', undefined, AHORA),
    ).toEqual({ alAdmin: false });
    expect(
      await armar({
        pedido: pedido({ failedVisitCount: 1 }),
      }).svc.prepararDeHoja('o1', 'rescheduled', undefined, AHORA),
    ).toEqual({ alAdmin: true });
    // Un pedido de hoja no acuerda para hoy (vuelve en la hoja de otro día).
    expect(
      await codigo(
        armar().svc.prepararDeHoja(
          'o1',
          'rescheduled',
          { date: HOY, timeSlotId: 'tarde' },
          AHORA,
        ),
      ),
    ).toBe(RevisitError.DIA_INVALIDO);
    // En el tope el acuerdo no se valida (decide el admin).
    expect(
      await armar({
        pedido: pedido({ failedVisitCount: 1 }),
      }).svc.prepararDeHoja(
        'o1',
        'rescheduled',
        { date: HOY, timeSlotId: 'tarde' },
        AHORA,
      ),
    ).toEqual({ alAdmin: true });
  });

  it('con la transacción de la hoja no abre otra: lee y escribe con ese manager', async () => {
    const t = armar({ pedido: liberado() });
    const otro = { ...t.manager };
    await t.svc.prepararDeHoja(
      'o1',
      'rescheduled',
      undefined,
      AHORA,
      otro as unknown as EntityManager,
    );
    await t.svc.registrarDeHoja(
      { ...deHoja, salida: 'rescheduled', rescheduledTo: LUNES },
      AHORA,
      otro as unknown as EntityManager,
    );
    expect(t.dataSource.transaction).not.toHaveBeenCalled();
    await t.svc.registrarDeHoja(
      { ...deHoja, salida: 'rescheduled', rescheduledTo: LUNES },
      AHORA,
    );
    expect(t.dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('primer intento (vuelve a pasar hoy): queda en el historial sin contar ni tocar el pedido', async () => {
    const t = armar({ pedido: pedido({ status: OrderStatus.ACCEPTED }) });
    const r = await t.svc.registrarDeHoja(
      { ...deHoja, salida: 'requeued' },
      AHORA,
    );
    expect(r).toMatchObject({
      failedVisitCount: 0,
      outcome: FailedVisitOutcome.REQUEUED,
      revisitStatus: null,
    });
    expect(t.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKind: DeliveryKind.ROUTE_SHEET,
        visitNumber: 1,
        outcome: FailedVisitOutcome.REQUEUED,
      }),
    );
    expect(t.manager.update).not.toHaveBeenCalled();
  });

  it('segundo intento: cuenta, y al día que puso la hoja le suma una franja con cupo (propuesta)', async () => {
    const t = armar({
      pedido: liberado(),
      ultimaVisita: { proposedTimeSlotId: 'tarde', finalTimeSlotId: null },
    });
    const r = await t.svc.registrarDeHoja(
      { ...deHoja, salida: 'rescheduled', rescheduledTo: LUNES },
      AHORA,
    );
    expect(r).toMatchObject({
      failedVisitCount: 1,
      outcome: FailedVisitOutcome.PROPOSED,
      revisitStatus: RevisitStatus.PROPOSED,
      scheduledDate: LUNES,
      timeSlotId: 'tarde',
    });
    expect(t.manager.update).toHaveBeenCalledWith(
      Order,
      { orderId: 'o1' },
      {
        failedVisitCount: 1,
        lastFailedVisitAt: AHORA,
        revisitStatus: RevisitStatus.PROPOSED,
        scheduledDate: LUNES,
        timeSlotId: 'tarde',
      },
    );
  });

  it('segundo intento sin cupo ese día: busca el siguiente día de la hoja con cupo (no propone el día sin franja)', async () => {
    const t = armar({
      pedido: liberado(),
      cupos: { [LUNES]: { manana: 0, tarde: 0 } },
    });
    const r = await t.svc.registrarDeHoja(
      {
        ...deHoja,
        salida: 'rescheduled',
        rescheduledTo: LUNES,
        dias: [LUNES, '2026-11-24', '2026-11-25'],
      },
      AHORA,
    );
    expect(r).toMatchObject({
      outcome: FailedVisitOutcome.PROPOSED,
      scheduledDate: '2026-11-24',
      timeSlotId: 'manana',
    });
  });

  it('segundo intento con todas las franjas llenas en los días de la hoja del horizonte: decide el admin, sin día ni franja', async () => {
    const t = armar({
      pedido: liberado(),
      cupos: {
        [LUNES]: { manana: 0, tarde: 0 },
        '2026-11-24': { manana: 0, tarde: 0 },
      },
    });
    const r = await t.svc.registrarDeHoja(
      {
        ...deHoja,
        salida: 'rescheduled',
        rescheduledTo: LUNES,
        // El 10/12 queda fuera del horizonte de dos semanas: no se mira.
        dias: [LUNES, '2026-11-24', '2026-12-10'],
      },
      AHORA,
    );
    expect(r).toMatchObject({
      outcome: FailedVisitOutcome.AWAITING_ADMIN,
      revisitStatus: RevisitStatus.AWAITING_ADMIN,
      scheduledDate: null,
      timeSlotId: null,
    });
    expect(t.timeSlots.getAvailability).not.toHaveBeenCalledWith(
      '2026-12-10',
      'dist',
    );
    expect(t.manager.query).not.toHaveBeenCalledWith(
      expect.stringContaining('failed_delivery'),
      ['o1'],
    );
  });

  it('segundo intento en una distribuidora sin franjas: propone sólo el día de la hoja', async () => {
    const t = armar({ pedido: liberado(), sinFranjas: true });
    const r = await t.svc.registrarDeHoja(
      {
        ...deHoja,
        salida: 'rescheduled',
        rescheduledTo: LUNES,
        dias: [LUNES, '2026-11-24'],
      },
      AHORA,
    );
    expect(r).toMatchObject({
      outcome: FailedVisitOutcome.PROPOSED,
      scheduledDate: LUNES,
      timeSlotId: null,
    });
  });

  it('el día que eligió la hoja vale aunque quede más allá de dos semanas', async () => {
    const t = armar({ pedido: liberado() });
    const r = await t.svc.registrarDeHoja(
      { ...deHoja, salida: 'rescheduled', rescheduledTo: '2026-12-10' },
      AHORA,
    );
    expect(r).toMatchObject({
      outcome: FailedVisitOutcome.PROPOSED,
      scheduledDate: '2026-12-10',
    });
  });

  it('sin día posible, o al llegar al tope: decide el admin y queda sin día ni franja', async () => {
    const sinDia = armar({ pedido: liberado() });
    const r1 = await sinDia.svc.registrarDeHoja(
      { ...deHoja, salida: 'rescheduled', rescheduledTo: null },
      AHORA,
    );
    expect(r1?.outcome).toBe(FailedVisitOutcome.AWAITING_ADMIN);
    expect(sinDia.manager.update).toHaveBeenCalledWith(
      Order,
      { orderId: 'o1' },
      {
        failedVisitCount: 1,
        lastFailedVisitAt: AHORA,
        revisitStatus: RevisitStatus.AWAITING_ADMIN,
        scheduledDate: null,
        timeSlotId: null,
      },
    );

    const tope = armar({ pedido: { ...liberado(), failedVisitCount: 1 } });
    const r2 = await tope.svc.registrarDeHoja(
      { ...deHoja, salida: 'rescheduled', rescheduledTo: LUNES },
      AHORA,
    );
    expect(r2).toMatchObject({
      failedVisitCount: 2,
      outcome: FailedVisitOutcome.AWAITING_ADMIN,
    });
  });

  it('si mientras tanto el pedido cambió (cancelado, entregado u otro chofer), no asienta nada', async () => {
    const cancelado = armar({
      pedido: pedido({ status: OrderStatus.CANCELLED }),
    });
    expect(
      await cancelado.svc.registrarDeHoja(
        { ...deHoja, salida: 'requeued' },
        AHORA,
      ),
    ).toBeNull();
    const sinLiberar = armar({ pedido: pedido() });
    expect(
      await sinLiberar.svc.registrarDeHoja(
        { ...deHoja, salida: 'rescheduled', rescheduledTo: LUNES },
        AHORA,
      ),
    ).toBeNull();
    expect(sinLiberar.manager.save).not.toHaveBeenCalled();
  });

  it('si la franja elegida se llena al tomarla, prueba la siguiente; un acuerdo que ya no vale cae en la propuesta', async () => {
    const t = armar({ pedido: liberado() });
    t.timeSlots.assertSlotAvailableTx
      .mockRejectedValueOnce(new BadRequestException('completa'))
      .mockResolvedValue(undefined);
    expect(
      await t.svc.registrarDeHoja(
        { ...deHoja, salida: 'rescheduled', rescheduledTo: LUNES },
        AHORA,
      ),
    ).toMatchObject({ scheduledDate: LUNES, timeSlotId: 'tarde' });

    const acuerdoViejo = armar({ pedido: liberado() });
    expect(
      await acuerdoViejo.svc.registrarDeHoja(
        {
          ...deHoja,
          salida: 'rescheduled',
          rescheduledTo: LUNES,
          // Un domingo: ya no vale, queda la propuesta del sistema.
          agreed: { date: '2026-11-22', timeSlotId: 'manana' },
        },
        AHORA,
      ),
    ).toMatchObject({
      outcome: FailedVisitOutcome.PROPOSED,
      scheduledDate: LUNES,
    });
  });

  it('segundo intento con acuerdo: queda confirmado el día acordado', async () => {
    const t = armar({ pedido: liberado() });
    const r = await t.svc.registrarDeHoja(
      {
        ...deHoja,
        salida: 'rescheduled',
        rescheduledTo: LUNES,
        agreed: { date: '2026-11-25', timeSlotId: 'manana' },
      },
      AHORA,
    );
    expect(r).toMatchObject({
      outcome: FailedVisitOutcome.AGREED,
      revisitStatus: RevisitStatus.CONFIRMED,
      scheduledDate: '2026-11-25',
      timeSlotId: 'manana',
    });
  });
});

describe('FailedVisitService: el cliente contesta y el admin fija', () => {
  const propuesto = (o: Partial<Order> = {}) =>
    pedido({
      status: OrderStatus.PENDING,
      deliveryId: null,
      failedVisitCount: 1,
      revisitStatus: RevisitStatus.PROPOSED,
      scheduledDate: LUNES,
      timeSlotId: 'tarde',
      ...o,
    });
  const ultima = { failedVisitId: 'v1', deliveryKind: DeliveryKind.SINGLE };

  it('«Me sirve»: confirma el día y la franja propuestos y lo anota en la visita', async () => {
    const t = armar({ pedido: propuesto(), ultimaVisita: ultima });
    const r = await t.svc.aceptar('o1', 'cli');
    expect(r.cambio).toBe(true);
    expect(r.pedido.revisitStatus).toBe(RevisitStatus.CONFIRMED);
    expect(t.manager.update).toHaveBeenCalledWith(
      OrderFailedVisit,
      { failedVisitId: 'v1' },
      expect.objectContaining({
        resolution: RevisitResolution.CUSTOMER_ACCEPTED,
        resolvedByUserId: 'cli',
        finalDate: LUNES,
        finalTimeSlotId: 'tarde',
      }),
    );
    expect(t.manager.update).toHaveBeenCalledWith(
      Order,
      { orderId: 'o1' },
      {
        revisitStatus: RevisitStatus.CONFIRMED,
        scheduledDate: LUNES,
        timeSlotId: 'tarde',
      },
    );
  });

  it('repetir el «Me sirve» no escribe de nuevo; sin propuesta abierta es 409', async () => {
    const ya = armar({
      pedido: propuesto({ revisitStatus: RevisitStatus.CONFIRMED }),
    });
    // El segundo de dos «Me sirve» (o uno repetido) ve, bloqueado, que ya está
    // confirmada: no escribe y dice que no hubo cambio (no se avisa de nuevo).
    expect((await ya.svc.aceptar('o1', 'cli')).cambio).toBe(false);
    expect(ya.manager.update).not.toHaveBeenCalled();

    for (const p of [
      propuesto({ revisitStatus: RevisitStatus.AWAITING_ADMIN }),
      propuesto({ revisitStatus: null }),
      propuesto({ deliveryId: 'chofer-2' }),
      propuesto({ status: OrderStatus.CANCELLED }),
    ]) {
      expect(await codigo(armar({ pedido: p }).svc.aceptar('o1', 'cli'))).toBe(
        RevisitError.NO_ABIERTA,
      );
    }
  });

  it('«Elegir otro día y horario»: valida el calendario y el cupo, y queda confirmado el elegido', async () => {
    const t = armar({ pedido: propuesto(), ultimaVisita: ultima });
    const r = await t.svc.elegir(
      'o1',
      'cli',
      { date: '2026-11-26', timeSlotId: 'manana' },
      AHORA,
    );
    expect(r).toMatchObject({
      revisitStatus: RevisitStatus.CONFIRMED,
      scheduledDate: '2026-11-26',
      timeSlotId: 'manana',
    });
    expect(t.timeSlots.assertSlotAvailableTx).toHaveBeenCalledWith(
      t.em,
      'manana',
      '2026-11-26',
      'dist',
    );
    expect(t.manager.update).toHaveBeenCalledWith(
      OrderFailedVisit,
      { failedVisitId: 'v1' },
      expect.objectContaining({
        resolution: RevisitResolution.CUSTOMER_CHANGED,
      }),
    );
  });

  it('el cliente no elige un día pasado, un domingo, más allá de dos semanas ni una franja sin cupo', async () => {
    const elegir = (date: string, o = {}) =>
      codigo(
        armar({ pedido: propuesto(), ultimaVisita: ultima, ...o }).svc.elegir(
          'o1',
          'cli',
          { date, timeSlotId: 'manana' },
          AHORA,
        ),
      );
    expect(await elegir('2026-11-20')).toBe(RevisitError.DIA_INVALIDO);
    expect(await elegir('2026-11-22')).toBe(RevisitError.DIA_INVALIDO);
    expect(await elegir('2026-12-07')).toBe(RevisitError.DIA_INVALIDO);
    expect(await elegir(LUNES, { franjaLlena: true })).toBe(
      RevisitError.FRANJA_SIN_CUPO,
    );
    expect(await elegir(LUNES, { enRecorrido: true })).toBe(
      RevisitError.YA_EN_RECORRIDO,
    );
  });

  it('un pedido que salió de una hoja de ruta no se elige para hoy; uno suelto sí', async () => {
    const elegirHoy = (deliveryKind: DeliveryKind) =>
      codigo(
        armar({
          pedido: propuesto(),
          ultimaVisita: { failedVisitId: 'v1', deliveryKind },
        }).svc.elegir('o1', 'cli', { date: HOY, timeSlotId: 'tarde' }, AHORA),
      );
    expect(await elegirHoy(DeliveryKind.ROUTE_SHEET)).toBe(
      RevisitError.DIA_INVALIDO,
    );
    expect(await elegirHoy(DeliveryKind.SINGLE)).toBe('sin error');
  });

  it('hoy no se elige si es feriado o si ya no queda ninguna franja vigente con lugar', async () => {
    const elegirHoy = (o: Parameters<typeof armar>[0]) =>
      codigo(
        armar({
          pedido: propuesto(),
          ultimaVisita: ultima,
          ...o,
        }).svc.elegir('o1', 'cli', { date: HOY, timeSlotId: 'tarde' }, AHORA),
      );
    expect(await elegirHoy({ feriados: [HOY] })).toBe(
      RevisitError.DIA_INVALIDO,
    );
    expect(await elegirHoy({ cupos: { [HOY]: { manana: 0, tarde: 0 } } })).toBe(
      RevisitError.DIA_INVALIDO,
    );
    // Queda una franja con lugar: el día vale y la franja la valida el cupo.
    expect(await elegirHoy({ cupos: { [HOY]: { manana: 0 } } })).toBe(
      'sin error',
    );
  });

  it('el cerrojo del despacho ocupado: 409 ORDER_BEING_DISPATCHED sin tocar nada; una oferta retirada se le avisa al chofer', async () => {
    const ocupado = armar({ pedido: propuesto(), ultimaVisita: ultima });
    ocupado.redis.withLock.mockResolvedValue({ obtenido: false } as never);
    expect(await codigo(ocupado.svc.aceptar('o1', 'cli'))).toBe(
      RevisitError.DESPACHANDO,
    );
    expect(ocupado.manager.update).not.toHaveBeenCalled();

    const conOferta = armar({ pedido: propuesto(), ultimaVisita: ultima });
    conOferta.manager.find.mockResolvedValue([{ driverId: 'u-otro' }]);
    await conOferta.svc.elegir(
      'o1',
      'cli',
      { date: '2026-11-26', timeSlotId: 'manana' },
      AHORA,
    );
    expect(conOferta.drivers.notifyOrderCancelled).toHaveBeenCalledWith(
      'u-otro',
      expect.objectContaining({ orderId: 'o1' }),
    );
  });

  it('un aviso de oferta retirada que falla no deshace el cambio', async () => {
    const t = armar({ pedido: propuesto(), ultimaVisita: ultima });
    t.manager.find.mockResolvedValue([{ driverId: 'u-otro' }]);
    t.drivers.notifyOrderCancelled.mockImplementation(() => {
      throw new Error('socket caído');
    });
    const r = await t.svc.elegir(
      'o1',
      'cli',
      { date: '2026-11-26', timeSlotId: 'manana' },
      AHORA,
    );
    expect(r.revisitStatus).toBe(RevisitStatus.CONFIRMED);
  });

  it('elegir el mismo día y franja que ya tiene no pide otro cupo', async () => {
    const t = armar({
      pedido: propuesto(),
      ultimaVisita: ultima,
      franjaLlena: true,
    });
    await t.svc.elegir(
      'o1',
      'cli',
      { date: LUNES, timeSlotId: 'tarde' },
      AHORA,
    );
    expect(t.timeSlots.assertSlotAvailableTx).not.toHaveBeenCalled();
  });

  it('el admin fija día y franja también cuando la decisión era suya', async () => {
    const t = armar({
      pedido: propuesto({ revisitStatus: RevisitStatus.AWAITING_ADMIN }),
      ultimaVisita: ultima,
    });
    const r = await t.svc.fijar(
      'o1',
      'admin',
      { date: '2026-11-27', timeSlotId: 'tarde' },
      AHORA,
    );
    expect(r).toMatchObject({
      revisitStatus: RevisitStatus.CONFIRMED,
      scheduledDate: '2026-11-27',
    });
    expect(t.manager.update).toHaveBeenCalledWith(
      OrderFailedVisit,
      { failedVisitId: 'v1' },
      expect.objectContaining({
        resolution: RevisitResolution.ADMIN_SET,
        resolvedByUserId: 'admin',
      }),
    );
  });

  it('el admin no fija la visita de un pedido sin visitas fallidas, con chofer o cerrado (409)', async () => {
    for (const p of [
      propuesto({ revisitStatus: null }),
      propuesto({ deliveryId: 'chofer-2' }),
      propuesto({ status: OrderStatus.DELIVERED }),
    ]) {
      expect(
        await codigo(
          armar({ pedido: p }).svc.fijar(
            'o1',
            'admin',
            { date: LUNES, timeSlotId: 'tarde' },
            AHORA,
          ),
        ),
      ).toBe(RevisitError.NO_ABIERTA);
    }
  });

  it('un pedido que no existe es 404', async () => {
    const t = armar();
    t.manager.createQueryBuilder.mockImplementation(() => {
      const qb = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      return qb;
    });
    t.manager.findOne.mockResolvedValue(null as never);
    await expect(t.svc.aceptar('nada', 'cli')).rejects.toThrow(
      'Pedido no encontrado',
    );
    await expect(t.svc.pedido('nada')).rejects.toThrow('Pedido no encontrado');
  });
});

describe('FailedVisitService: cambio de agenda desde la edición del pedido', () => {
  const abierto = (o: Partial<Order> = {}) =>
    pedido({
      status: OrderStatus.PENDING,
      deliveryId: null,
      failedVisitCount: 1,
      revisitStatus: RevisitStatus.PROPOSED,
      scheduledDate: LUNES,
      ...o,
    });
  const ultima = { failedVisitId: 'v1', deliveryKind: DeliveryKind.SINGLE };

  it('sin nueva visita abierta no hace nada; el cliente sólo mientras es propuesta; sin día, 400', async () => {
    const sin = armar({ pedido: abierto({ revisitStatus: null }) });
    await sin.svc.alCambiarLaAgenda(
      sin.em,
      sin.pedido,
      { date: LUNES, timeSlotId: 'tarde' },
      { userId: 'cli', esCliente: true },
      AHORA,
    );
    expect(sin.manager.update).not.toHaveBeenCalled();

    const confirmada = armar({
      pedido: abierto({ revisitStatus: RevisitStatus.CONFIRMED }),
    });
    expect(
      await codigo(
        confirmada.svc.alCambiarLaAgenda(
          confirmada.em,
          confirmada.pedido,
          { date: LUNES, timeSlotId: 'tarde' },
          { userId: 'cli', esCliente: true },
          AHORA,
        ),
      ),
    ).toBe(RevisitError.NO_ABIERTA);
    const sinDia = armar({ pedido: abierto() });
    expect(
      await codigo(
        sinDia.svc.alCambiarLaAgenda(
          sinDia.em,
          sinDia.pedido,
          { date: null, timeSlotId: null },
          { userId: 'admin', esCliente: false },
          AHORA,
        ),
      ),
    ).toBe(RevisitError.DIA_INVALIDO);
  });

  it('el admin la deja confirmada con el día nuevo; el cliente, como «elegir otro día»', async () => {
    const admin = armar({ pedido: abierto(), ultimaVisita: ultima });
    await admin.svc.alCambiarLaAgenda(
      admin.em,
      admin.pedido,
      { date: '2026-11-25', timeSlotId: 'manana' },
      { userId: 'admin', esCliente: false },
      AHORA,
    );
    expect(admin.pedido).toMatchObject({
      revisitStatus: RevisitStatus.CONFIRMED,
      scheduledDate: '2026-11-25',
    });
    expect(admin.manager.update).toHaveBeenCalledWith(
      OrderFailedVisit,
      { failedVisitId: 'v1' },
      expect.objectContaining({ resolution: RevisitResolution.ADMIN_SET }),
    );
    const cliente = armar({ pedido: abierto(), ultimaVisita: ultima });
    await cliente.svc.alCambiarLaAgenda(
      cliente.em,
      cliente.pedido,
      { date: '2026-11-25', timeSlotId: 'manana' },
      { userId: 'cli', esCliente: true },
      AHORA,
    );
    expect(cliente.manager.update).toHaveBeenCalledWith(
      OrderFailedVisit,
      { failedVisitId: 'v1' },
      expect.objectContaining({
        resolution: RevisitResolution.CUSTOMER_CHANGED,
      }),
    );
  });
});

describe('FailedVisitService: opciones', () => {
  it('ofrece hoy (lo que queda) y los días hábiles de dos semanas, sólo con franjas libres', async () => {
    const t = armar({
      pedido: pedido({ status: OrderStatus.PENDING, deliveryId: null }),
      cupos: { [HOY]: { manana: 0 }, [LUNES]: { manana: 0, tarde: 0 } },
    });
    const dias = await t.svc.opciones(t.pedido, AHORA);
    expect(dias[0]).toEqual({
      date: HOY,
      slots: [expect.objectContaining({ timeSlotId: 'tarde', remaining: 5 })],
      canAgree: true,
    });
    const fechas = dias.map((d) => d.date);
    expect(fechas).not.toContain('2026-11-22'); // domingo
    expect(fechas).not.toContain(LUNES); // sin cupo
    expect(fechas).toHaveLength(12);
    expect(fechas[fechas.length - 1]).toBe('2026-12-05');
  });

  it('hoy feriado (o un día que la distribuidora no reparte) no se ofrece, aunque haya franjas con cupo', async () => {
    const t = armar({ feriados: [HOY] });
    const dias = await t.svc.opciones(t.pedido, AHORA);
    expect(dias[0].date).toBe(LUNES);
  });

  it('hoy sin franjas vigentes no se ofrece', async () => {
    const t = armar({ cupos: { [HOY]: { manana: 0, tarde: 0 } } });
    expect((await t.svc.opciones(t.pedido, AHORA))[0].date).toBe(LUNES);
  });

  it('canAgree: false en el primer intento de una parada de hoja en curso; true en el segundo y fuera de una hoja', async () => {
    const primero = armar({ paradaDeHoja: 0 });
    const dias = await primero.svc.opciones(primero.pedido, AHORA);
    expect(dias.length).toBeGreaterThan(0);
    expect(dias.every((d) => d.canAgree === false)).toBe(true);

    const segundo = armar({ paradaDeHoja: 1 });
    expect(
      (await segundo.svc.opciones(segundo.pedido, AHORA)).every(
        (d) => d.canAgree,
      ),
    ).toBe(true);
    const suelto = armar();
    expect((await suelto.svc.opciones(suelto.pedido, AHORA))[0].canAgree).toBe(
      true,
    );
  });

  it('contextoDelChofer: tipo de entrega e intento', async () => {
    expect(
      await armar({ paradaDeHoja: 0 }).svc.contextoDelChofer('o1'),
    ).toEqual({
      deliveryKind: DeliveryKind.ROUTE_SHEET,
      attempt: 1,
      canAgree: false,
    });
    expect(
      await armar({
        pedido: pedido({
          deliveryMode: OrderDeliveryMode.EXPRESS,
          failedVisitCount: 1,
        }),
      }).svc.contextoDelChofer('o1'),
    ).toEqual({
      deliveryKind: DeliveryKind.EXPRESS,
      attempt: 2,
      canAgree: true,
    });
  });

  it('para un pedido que salió de una hoja de ruta no ofrece hoy', async () => {
    const t = armar({
      ultimaVisita: { deliveryKind: DeliveryKind.ROUTE_SHEET },
    });
    const dias = await t.svc.opciones(t.pedido, AHORA);
    expect(dias[0].date).toBe(LUNES);
  });

  it('motivoLegible: la etiqueta y, si hay, la nota', () => {
    expect(motivoLegible({ reason: FailedVisitReason.ADDRESS_CLOSED })).toBe(
      'El domicilio estaba cerrado',
    );
    expect(
      motivoLegible({
        reason: FailedVisitReason.REJECTED,
        note: ' no lo quiso ',
      }),
    ).toBe('El cliente rechazó el pedido: no lo quiso');
  });
});
