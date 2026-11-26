import { DataSource } from 'typeorm';
import { RoleType } from '../common/constants/role-type.enum';
import { DeliveryService } from '../delivery/delivery.service';
import { ReleaseOrderUseCase } from '../order/application/release-order.use-case';
import { DispatchOffer } from '../order/entities/dispatch-offer.entity';
import { Order, OrderStatus } from '../order/entities/order.entity';
import {
  FailedDeliveryReason,
  RouteSheetStopsService,
} from '../route-batch/application/route-sheet-stops.service';
import {
  DeliveryKind,
  FailedVisitOutcome,
  FailedVisitReason,
  RevisitStatus,
} from './domain/nueva-visita';
import { FailedVisitNotifier } from './failed-visit.notifier';
import { FailedVisitService } from './failed-visit.service';
import {
  FailedDeliveryError,
  NoPudeEntregar,
  ReportFailedDeliveryUseCase,
} from './report-failed-delivery.use-case';

const error = async (p: Promise<unknown>) => {
  try {
    await p;
    return { status: 0, code: 'sin error' };
  } catch (e) {
    const ex = e as {
      getStatus: () => number;
      getResponse: () => { code?: string };
    };
    return { status: ex.getStatus(), code: ex.getResponse().code };
  }
};

const entrada = (o: Partial<NoPudeEntregar> = {}): NoPudeEntregar => ({
  orderId: 'o1',
  userId: 'u-chofer',
  role: RoleType.DELIVERY,
  reason: FailedVisitReason.CUSTOMER_ABSENT,
  latitude: -27.36,
  longitude: -55.9,
  accuracyMeters: 10,
  ...o,
});

function armar(
  o: {
    pedido?: Partial<Order> | null;
    bloqueado?: Partial<Order> | null;
    parada?: { sheetId: string; failedAttempts: number } | null;
    chofer?: { deliveryId: string } | null;
  } = {},
) {
  const base = {
    orderId: 'o1',
    distributorId: 'dist',
    customerId: 'cli',
    status: OrderStatus.ON_THE_WAY,
    deliveryId: 'chofer-1',
    failedVisitCount: 0,
    revisitStatus: null,
    timeSlotId: null,
  };
  const leido = o.pedido === null ? null : { ...base, ...o.pedido };
  const bloqueado =
    o.bloqueado === null ? null : { ...base, ...o.pedido, ...o.bloqueado };
  const orden: string[] = [];
  const manager = {
    createQueryBuilder: jest.fn(() => {
      const qb = {
        setLock: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(bloqueado),
      };
      return qb;
    }),
    update: jest.fn(() => {
      orden.push('constancias');
      return Promise.resolve();
    }),
    save: jest.fn((p: Order) => {
      orden.push('guardar');
      return Promise.resolve(p);
    }),
    findOne: jest.fn().mockResolvedValue(leido),
  };
  const dataSource = {
    manager,
    transaction: jest.fn((fn: (m: unknown) => unknown) => fn(manager)),
    query: jest.fn().mockResolvedValue(o.parada ? [o.parada] : []),
  };
  const deliveries = {
    buscarPorIdOUsuario: jest
      .fn()
      .mockResolvedValue(
        o.chofer === undefined ? { deliveryId: 'chofer-1' } : o.chofer,
      ),
  };
  const release = {
    releaseWithin: jest.fn((_m: unknown, p: Order) => {
      orden.push('liberar');
      p.status = OrderStatus.PENDING;
      p.deliveryId = null;
      return Promise.resolve('u-chofer');
    }),
    notifyReleased: jest.fn().mockResolvedValue(undefined),
  };
  const visitas = {
    registrar: jest.fn((_m: unknown, p: Order) => {
      orden.push('visita');
      p.failedVisitCount = 1;
      p.revisitStatus = RevisitStatus.PROPOSED;
      p.scheduledDate = '2026-11-23';
      p.timeSlotId = 'tarde';
      return Promise.resolve({
        visit: { failedVisitId: 'v1', deliveryKind: DeliveryKind.SINGLE },
        failedVisitCount: 1,
        outcome: FailedVisitOutcome.PROPOSED,
        revisitStatus: RevisitStatus.PROPOSED,
        scheduledDate: '2026-11-23',
        timeSlotId: 'tarde',
      });
    }),
  };
  const avisos = { visitaFallida: jest.fn().mockResolvedValue(undefined) };
  const paradas = {
    noEntregada: jest.fn().mockResolvedValue({
      sheetId: 'hoja-1',
      orderId: 'o1',
      nextOrderId: 'o7',
      visita: {
        visit: { failedVisitId: 'v2' },
        failedVisitCount: 0,
        outcome: FailedVisitOutcome.REQUEUED,
        revisitStatus: null,
        scheduledDate: null,
        timeSlotId: null,
      },
    }),
  };
  const uc = new ReportFailedDeliveryUseCase(
    dataSource as unknown as DataSource,
    deliveries as unknown as DeliveryService,
    release as unknown as ReleaseOrderUseCase,
    visitas as unknown as FailedVisitService,
    avisos as unknown as FailedVisitNotifier,
    paradas as unknown as RouteSheetStopsService,
  );
  return { uc, manager, release, visitas, avisos, paradas, orden };
}

describe('ReportFailedDeliveryUseCase («No pude entregar»)', () => {
  it('pedido suelto en camino: asienta la visita, libera al chofer por el camino único y guarda, todo con el pedido bloqueado', async () => {
    const t = armar();
    const r = await t.uc.execute(entrada());

    expect(t.orden).toEqual(['visita', 'liberar', 'guardar']);
    expect(r).toMatchObject({
      outcome: FailedVisitOutcome.PROPOSED,
      failedVisitCount: 1,
      deliveryKind: DeliveryKind.SINGLE,
      nextOrderId: null,
      scheduledDate: '2026-11-23',
      timeSlotId: 'tarde',
    });
    // El pedido vuelve a pendiente sin chofer por la máquina de estados (liberación).
    expect(t.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: OrderStatus.PENDING,
        deliveryId: null,
        revisitStatus: RevisitStatus.PROPOSED,
      }),
    );
    // Las ofertas viejas no se tocan: la retención ignora las anteriores a la
    // última visita fallida, así el chofer puede volver a recibirlo.
    expect(t.manager.update).not.toHaveBeenCalledWith(
      DispatchOffer,
      expect.anything(),
      expect.anything(),
    );
  });

  it('después del commit: suelta al chofer sin dejarle la constancia y le avisa la nueva visita al cliente', async () => {
    const t = armar();
    await t.uc.execute(entrada({ reason: FailedVisitReason.ADDRESS_CLOSED }));
    expect(t.release.notifyReleased).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'o1' }),
      'u-chofer',
      { porEntregaFallida: true },
    );
    expect(t.avisos.visitaFallida).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'o1',
        revisitStatus: RevisitStatus.PROPOSED,
      }),
      'El domicilio estaba cerrado',
    );
  });

  it('un aviso que falla no cambia la respuesta: la visita ya quedó', async () => {
    const t = armar();
    t.release.notifyReleased.mockRejectedValue(new Error('socket caído'));
    t.avisos.visitaFallida.mockRejectedValue(new Error('fcm caído'));
    const r = await t.uc.execute(entrada());
    expect(r.outcome).toBe(FailedVisitOutcome.PROPOSED);
  });

  it('409 si el pedido no está en camino (pendiente, aceptado, entregado): no se asienta nada', async () => {
    for (const status of [
      OrderStatus.PENDING,
      OrderStatus.ACCEPTED,
      OrderStatus.DELIVERED,
      OrderStatus.CANCELLED,
    ]) {
      const t = armar({ pedido: { status } });
      expect(await error(t.uc.execute(entrada()))).toEqual({
        status: 409,
        code: FailedDeliveryError.NO_EN_CAMINO,
      });
      expect(t.visitas.registrar).not.toHaveBeenCalled();
      expect(t.manager.save).not.toHaveBeenCalled();
    }
  });

  it('403 si el pedido es de otro chofer, también si se reasignó mientras se esperaba el lock', async () => {
    const otro = armar({ chofer: { deliveryId: 'chofer-9' } });
    expect((await error(otro.uc.execute(entrada()))).status).toBe(403);
    const sinPerfil = armar({ chofer: null });
    expect((await error(sinPerfil.uc.execute(entrada()))).status).toBe(403);

    const reasignado = armar({ bloqueado: { deliveryId: 'chofer-9' } });
    expect((await error(reasignado.uc.execute(entrada()))).status).toBe(403);
    expect(reasignado.visitas.registrar).not.toHaveBeenCalled();
  });

  it('403 para un cliente; 404 si el pedido no existe (o desapareció antes del lock)', async () => {
    expect(
      (await error(armar().uc.execute(entrada({ role: RoleType.CUSTOMER }))))
        .status,
    ).toBe(403);
    expect(
      (await error(armar({ pedido: null }).uc.execute(entrada()))).status,
    ).toBe(404);
    expect(
      (await error(armar({ bloqueado: null }).uc.execute(entrada()))).status,
    ).toBe(404);
  });

  it('400: el chofer sin ubicación, o «otro» sin nota', async () => {
    const t = armar();
    expect(
      await error(t.uc.execute(entrada({ latitude: null, longitude: null }))),
    ).toEqual({ status: 400, code: 'VALIDATION' });
    expect(
      await error(
        t.uc.execute(entrada({ reason: FailedVisitReason.OTHER, note: ' a ' })),
      ),
    ).toEqual({ status: 400, code: 'VALIDATION' });
    expect(t.visitas.registrar).not.toHaveBeenCalled();
  });

  it('un admin lo informa sin ubicación y sin ser el chofer', async () => {
    const t = armar();
    const r = await t.uc.execute(
      entrada({
        role: RoleType.ADMIN,
        userId: 'u-admin',
        latitude: null,
        longitude: null,
      }),
    );
    expect(r.outcome).toBe(FailedVisitOutcome.PROPOSED);
    expect(t.visitas.registrar).toHaveBeenCalled();
  });

  it('parada de una hoja de ruta en curso: sigue el circuito de la hoja, con el motivo traducido y la ubicación', async () => {
    const t = armar({ parada: { sheetId: 'hoja-1', failedAttempts: 0 } });
    const datos = entrada({ reason: FailedVisitReason.ADDRESS_CLOSED });
    const r = await t.uc.execute(datos);
    expect(t.paradas.noEntregada).toHaveBeenCalledWith(
      'dist',
      'hoja-1',
      'o1',
      { userId: 'u-chofer', esChofer: true },
      { reason: FailedDeliveryReason.NO_ACCESS, note: undefined },
      datos,
    );
    expect(r).toMatchObject({
      deliveryKind: DeliveryKind.ROUTE_SHEET,
      outcome: FailedVisitOutcome.REQUEUED,
      nextOrderId: 'o7',
    });
    // La hoja hace sus transiciones: acá no se libera ni se asienta de nuevo.
    expect(t.visitas.registrar).not.toHaveBeenCalled();
    expect(t.release.releaseWithin).not.toHaveBeenCalled();
  });

  it('hoja de ruta: en el primer intento no se acuerda otro día (409); en el segundo, sí', async () => {
    const acuerdo = { date: '2026-11-25', timeSlotId: 'tarde' };
    const primero = armar({ parada: { sheetId: 'hoja-1', failedAttempts: 0 } });
    expect(
      await error(primero.uc.execute(entrada({ agreed: acuerdo }))),
    ).toEqual({ status: 409, code: FailedDeliveryError.ACUERDO_EN_REINTENTO });
    expect(primero.paradas.noEntregada).not.toHaveBeenCalled();

    const segundo = armar({ parada: { sheetId: 'hoja-1', failedAttempts: 1 } });
    await segundo.uc.execute(entrada({ agreed: acuerdo }));
    expect(segundo.paradas.noEntregada).toHaveBeenCalled();
  });

  it('hoja de ruta: si la hoja no pudo asentar la visita (no cambió nada), el error sube tal cual', async () => {
    const t = armar({ parada: { sheetId: 'hoja-1', failedAttempts: 0 } });
    t.paradas.noEntregada.mockRejectedValue(new Error('base caída'));
    await expect(t.uc.execute(entrada())).rejects.toThrow('base caída');
    expect(t.avisos.visitaFallida).not.toHaveBeenCalled();
  });
});
