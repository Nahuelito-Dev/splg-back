import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Order, OrderStatus } from '../order/entities/order.entity';
import { OrderService } from '../order/order.service';
import {
  DeliveryKind,
  FailedVisitOutcome,
  FailedVisitReason,
  RevisitStatus,
} from './domain/nueva-visita';
import {
  FailedDeliveryV3Controller,
  FailedVisitsV3Controller,
  nuevaVisitaADto,
} from './failed-delivery-v3.controller';
import { FailedVisitQueryService } from './failed-visit-query.service';
import { FailedVisitNotifier } from './failed-visit.notifier';
import { FailedVisitService } from './failed-visit.service';
import { ReportFailedDeliveryUseCase } from './report-failed-delivery.use-case';

const usuario = (role: RoleType, id = 'cli'): AuthenticatedUser =>
  ({ user_id: id, role }) as AuthenticatedUser;

const pedido = (o: Partial<Order> = {}): Order =>
  ({
    orderId: 'o1',
    distributorId: 'dist',
    customerId: 'cli',
    status: OrderStatus.PENDING,
    deliveryId: null,
    failedVisitCount: 1,
    revisitStatus: RevisitStatus.PROPOSED,
    scheduledDate: '2026-11-26',
    timeSlotId: 'manana',
    timeSlot: { name: 'Mañana', startTime: '09:00:00', endTime: '13:00:00' },
    ...o,
  }) as Order;

function armar(p: Order = pedido(), despues: Order = p) {
  const orders = {
    assertDeLaDistribuidora: jest.fn().mockResolvedValue(undefined),
    assertEsElChofer: jest.fn((deliveryId: string, userId: string) =>
      deliveryId === 'chofer-1' && userId === 'u-chofer'
        ? Promise.resolve()
        : Promise.reject(new Error('no es su pedido')),
    ),
  };
  const noPude = {
    execute: jest.fn().mockResolvedValue({
      visit: { failedVisitId: 'v1' },
      outcome: FailedVisitOutcome.PROPOSED,
      deliveryKind: DeliveryKind.SINGLE,
      nextOrderId: null,
    }),
  };
  const visitas = {
    pedido: jest.fn().mockResolvedValueOnce(p).mockResolvedValue(despues),
    opciones: jest.fn().mockResolvedValue([{ date: '2026-11-26', slots: [] }]),
    aceptar: jest.fn().mockResolvedValue({
      pedido: despues,
      cambio: p.revisitStatus !== despues.revisitStatus,
    }),
    elegir: jest.fn().mockResolvedValue(despues),
    fijar: jest.fn().mockResolvedValue(despues),
  };
  const consultas = {
    historial: jest.fn().mockResolvedValue([{ failedVisitId: 'v1' }]),
    listar: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  };
  const avisos = {
    respondida: jest.fn().mockResolvedValue(undefined),
    fijadaPorElAdmin: jest.fn().mockResolvedValue(undefined),
  };
  const c = new FailedDeliveryV3Controller(
    orders as unknown as OrderService,
    noPude as unknown as ReportFailedDeliveryUseCase,
    visitas as unknown as FailedVisitService,
    consultas as unknown as FailedVisitQueryService,
    avisos as unknown as FailedVisitNotifier,
  );
  return { c, orders, noPude, visitas, consultas, avisos };
}

describe('nuevaVisitaADto', () => {
  it('la propuesta con su franja y si el cliente puede contestar', () => {
    expect(nuevaVisitaADto(pedido())).toEqual({
      orderId: 'o1',
      status: RevisitStatus.PROPOSED,
      failedVisitCount: 1,
      scheduledDate: '2026-11-26',
      timeSlotId: 'manana',
      timeSlotName: 'Mañana',
      windowStart: '09:00:00',
      windowEnd: '13:00:00',
      canRespond: true,
    });
  });

  it('con la decisión en el admin no muestra fecha ni deja contestar', () => {
    expect(
      nuevaVisitaADto(pedido({ revisitStatus: RevisitStatus.AWAITING_ADMIN })),
    ).toMatchObject({
      status: RevisitStatus.AWAITING_ADMIN,
      scheduledDate: null,
      timeSlotId: null,
      windowStart: null,
      canRespond: false,
    });
  });

  it('un pedido sin visitas fallidas: status null', () => {
    expect(
      nuevaVisitaADto(
        pedido({ revisitStatus: null, failedVisitCount: 0, timeSlot: null }),
      ),
    ).toMatchObject({ status: null, failedVisitCount: 0, canRespond: false });
  });
});

describe('FailedDeliveryV3Controller', () => {
  it('«No pude entregar»: controla la distribuidora, pasa el cuerpo al caso de uso y responde cómo quedó la visita', async () => {
    const t = armar();
    const r = await t.c.failedDelivery(
      usuario(RoleType.DELIVERY, 'u-chofer'),
      'o1',
      {
        reason: FailedVisitReason.CUSTOMER_ABSENT,
        latitude: -27.3,
        longitude: -55.9,
        agreed: { scheduledDate: '2026-11-26', timeSlotId: 'manana' },
      },
      'dist',
    );
    expect(t.orders.assertDeLaDistribuidora).toHaveBeenCalledWith('o1', 'dist');
    expect(t.noPude.execute).toHaveBeenCalledWith({
      orderId: 'o1',
      userId: 'u-chofer',
      role: RoleType.DELIVERY,
      reason: FailedVisitReason.CUSTOMER_ABSENT,
      note: null,
      latitude: -27.3,
      longitude: -55.9,
      accuracyMeters: null,
      agreed: { date: '2026-11-26', timeSlotId: 'manana' },
    });
    expect(r).toMatchObject({
      failedVisitId: 'v1',
      outcome: FailedVisitOutcome.PROPOSED,
      deliveryKind: DeliveryKind.SINGLE,
      nextOrderId: null,
      status: RevisitStatus.PROPOSED,
      scheduledDate: '2026-11-26',
    });
  });

  it('sin acuerdo manda agreed null', async () => {
    const t = armar();
    await t.c.failedDelivery(
      usuario(RoleType.ADMIN, 'u-admin'),
      'o1',
      { reason: FailedVisitReason.REJECTED },
      'dist',
    );
    expect(t.noPude.execute).toHaveBeenCalledWith(
      expect.objectContaining({ agreed: null, latitude: null }),
    );
  });

  it('el pedido de otro cliente o de otra distribuidora no existe (404) en ninguna lectura ni respuesta', async () => {
    const ajeno = usuario(RoleType.CUSTOMER, 'otro');
    for (const llamada of [
      (c: FailedDeliveryV3Controller) => c.revisit(ajeno, 'o1', null),
      (c: FailedDeliveryV3Controller) => c.options(ajeno, 'o1', null),
      (c: FailedDeliveryV3Controller) => c.accept(ajeno, 'o1', null),
      (c: FailedDeliveryV3Controller) =>
        c.choose(
          ajeno,
          'o1',
          { scheduledDate: '2026-11-26', timeSlotId: 'manana' },
          null,
        ),
      (c: FailedDeliveryV3Controller) =>
        c.revisit(usuario(RoleType.ADMIN), 'o1', 'otra-dist'),
      (c: FailedDeliveryV3Controller) => c.failedVisits('o1', 'otra-dist'),
      (c: FailedDeliveryV3Controller) =>
        c.schedule(
          usuario(RoleType.ADMIN),
          'o1',
          { scheduledDate: '2026-11-26', timeSlotId: 'manana' },
          'otra-dist',
        ),
    ]) {
      const t = armar();
      await expect(llamada(t.c)).rejects.toThrow('Pedido no encontrado');
      expect(t.visitas.aceptar).not.toHaveBeenCalled();
      expect(t.visitas.elegir).not.toHaveBeenCalled();
      expect(t.visitas.fijar).not.toHaveBeenCalled();
    }
  });

  it('el chofer ve las opciones sólo del pedido que tiene asignado (para acordar con el cliente)', async () => {
    const enCamino = pedido({
      status: OrderStatus.ON_THE_WAY,
      deliveryId: 'chofer-1',
      revisitStatus: null,
    });
    const suyo = armar(enCamino);
    expect(
      await suyo.c.options(
        usuario(RoleType.DELIVERY, 'u-chofer'),
        'o1',
        'dist',
      ),
    ).toEqual([{ date: '2026-11-26', slots: [] }]);

    const deOtro = armar(enCamino);
    await expect(
      deOtro.c.options(usuario(RoleType.DELIVERY, 'u-otro'), 'o1', 'dist'),
    ).rejects.toThrow('Pedido no encontrado');
    const sinChofer = armar(pedido());
    await expect(
      sinChofer.c.options(usuario(RoleType.DELIVERY, 'u-chofer'), 'o1', 'dist'),
    ).rejects.toThrow('Pedido no encontrado');
    expect(deOtro.visitas.opciones).not.toHaveBeenCalled();
  });

  it('el dueño lee su nueva visita y las opciones; el admin, el historial', async () => {
    const t = armar();
    expect(
      await t.c.revisit(usuario(RoleType.CUSTOMER), 'o1', null),
    ).toMatchObject({ status: RevisitStatus.PROPOSED });
    expect(await t.c.options(usuario(RoleType.CUSTOMER), 'o1', null)).toEqual([
      { date: '2026-11-26', slots: [] },
    ]);
    expect(await t.c.failedVisits('o1', 'dist')).toEqual([
      { failedVisitId: 'v1' },
    ]);
    expect(t.consultas.historial).toHaveBeenCalledWith('o1');
  });

  it('«Me sirve»: confirma y avisa; repetirlo no vuelve a avisar', async () => {
    const t = armar(
      pedido(),
      pedido({ revisitStatus: RevisitStatus.CONFIRMED }),
    );
    const r = await t.c.accept(usuario(RoleType.CUSTOMER), 'o1', null);
    expect(t.visitas.aceptar).toHaveBeenCalledWith('o1', 'cli');
    expect(r).toMatchObject({
      status: RevisitStatus.CONFIRMED,
      canRespond: false,
    });
    expect(t.avisos.respondida).toHaveBeenCalledWith(
      expect.objectContaining({ revisitStatus: RevisitStatus.CONFIRMED }),
      false,
    );

    const ya = pedido({ revisitStatus: RevisitStatus.CONFIRMED });
    const repetido = armar(ya, ya);
    await repetido.c.accept(usuario(RoleType.CUSTOMER), 'o1', null);
    expect(repetido.avisos.respondida).not.toHaveBeenCalled();
  });

  it('«Me sirve» simultáneo: las dos llamadas leyeron la propuesta, pero sólo avisa la que la confirmó', async () => {
    const antes = pedido();
    const despues = pedido({ revisitStatus: RevisitStatus.CONFIRMED });
    // La segunda ve, bloqueada, que ya está confirmada: el servicio dice «sin cambio».
    const segunda = armar(antes, despues);
    segunda.visitas.aceptar.mockResolvedValue({
      pedido: despues,
      cambio: false,
    });
    await segunda.c.accept(usuario(RoleType.CUSTOMER), 'o1', null);
    expect(segunda.avisos.respondida).not.toHaveBeenCalled();
  });

  it('«Elegir otro día y horario»: pasa el día y la franja y avisa el cambio', async () => {
    const t = armar();
    await t.c.choose(
      usuario(RoleType.CUSTOMER),
      'o1',
      { scheduledDate: '2026-11-27', timeSlotId: 'tarde' },
      null,
    );
    expect(t.visitas.elegir).toHaveBeenCalledWith('o1', 'cli', {
      date: '2026-11-27',
      timeSlotId: 'tarde',
    });
    expect(t.avisos.respondida).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('el admin fija día y franja y se le avisa al cliente', async () => {
    const t = armar();
    await t.c.schedule(
      usuario(RoleType.ADMIN, 'u-admin'),
      'o1',
      { scheduledDate: '2026-11-27', timeSlotId: 'tarde' },
      'dist',
    );
    expect(t.visitas.fijar).toHaveBeenCalledWith('o1', 'u-admin', {
      date: '2026-11-27',
      timeSlotId: 'tarde',
    });
    expect(t.avisos.fijadaPorElAdmin).toHaveBeenCalled();
  });
});

describe('FailedVisitsV3Controller', () => {
  it('lista dentro de la distribuidora en contexto', async () => {
    const consultas = { listar: jest.fn().mockResolvedValue({ total: 0 }) };
    const c = new FailedVisitsV3Controller(
      consultas as unknown as FailedVisitQueryService,
    );
    await c.list({ status: 'open' }, 'dist');
    expect(consultas.listar).toHaveBeenCalledWith('dist', { status: 'open' });
  });
});
