import { NotFoundException } from '@nestjs/common';
import { OrderService } from './order.service';
import { Order, OrderStatus } from './entities/order.entity';
import type { Repository, DataSource } from 'typeorm';
import type { DeliveryService } from '../delivery/delivery.service';
import type { RealtimeDispatchPort } from './domain/ports/realtime-dispatch.port';
import type { OrderRepositoryPort } from './domain/ports/order.repository.port';
import type { CreateOrderUseCase } from './application/create-order.use-case';
import type { UpdateOrderStatusUseCase } from './application/update-order-status.use-case';
import type { CancelOrderUseCase } from './application/cancel-order.use-case';
import type { ConfirmDeliveryUseCase } from './application/confirm-delivery.use-case';
import type { DispatchOrchestratorService } from './application/dispatch-orchestrator.service';
import type { DispatchOfferRepositoryPort } from './domain/ports/dispatch-offer.repository.port';
import type { NotificationPort } from './domain/ports/notification.port';
import type { FleetDispatchLockService } from '../fleet/fleet-dispatch-lock.service';

/**
 * `POST /orders/:id/reject` (CU-016 + H-55).
 *
 * "Rechazar" significa dos cosas distintas según cómo llegó el pedido:
 *  - Oferta REAL del despacho automático (hay fila `OFFERED` de ESTE
 *    chofer): cierra esa oferta y re-ofrece al siguiente chofer
 *    (comportamiento de siempre, `DispatchOrchestratorService.onDriverRejected`).
 *  - Asignación MANUAL del admin, sin ninguna oferta activa SUYA: segunda
 *    revisión, punto 1 (decisión de nahue) — el pedido NO cambia. La app del
 *    chofer manda este mismo `/reject` tanto si lo rechaza a propósito como
 *    si deja vencer el aviso de los 30s (que no es una oferta real, nada
 *    expira del lado del servidor), así que liberar acá deshacía lo que un
 *    admin decidió a mano. En vez de liberar: se avisa a los admins
 *    (`order:assignment-declined`) para que decidan.
 */
describe('OrderService · rejectOffer', () => {
  const PEDIDO = 'f1f1f1f1-0000-4000-8000-000000000008';
  const CHOFER_USER_ID = 'u3u3u3u3-0000-4000-8000-000000000009';
  const DISTRIBUIDORA = 'dist-1';

  let orders: { findByIdFull: jest.Mock };
  let dispatch: { notifyAdmins: jest.Mock };
  let dispatchOrchestrator: { onDriverRejected: jest.Mock };
  let dispatchOffers: { hasActiveOffer: jest.Mock };
  let service: OrderService;

  const pedidoAsignadoManualmente = (): Order =>
    ({
      orderId: PEDIDO,
      distributorId: DISTRIBUIDORA,
      status: OrderStatus.ACCEPTED,
      delivery: { userId: CHOFER_USER_ID, user: { fullName: 'Chofer Test' } },
    }) as unknown as Order;

  beforeEach(() => {
    orders = { findByIdFull: jest.fn() };
    dispatch = { notifyAdmins: jest.fn() };
    dispatchOrchestrator = {
      onDriverRejected: jest.fn().mockResolvedValue(undefined),
    };
    dispatchOffers = { hasActiveOffer: jest.fn() };

    service = new OrderService(
      {} as unknown as Repository<Order>,
      {} as unknown as DeliveryService,
      dispatch as unknown as RealtimeDispatchPort,
      orders as unknown as OrderRepositoryPort,
      {} as unknown as CreateOrderUseCase,
      {} as unknown as UpdateOrderStatusUseCase,
      {} as unknown as CancelOrderUseCase,
      {} as unknown as ConfirmDeliveryUseCase,
      dispatchOrchestrator as unknown as DispatchOrchestratorService,
      dispatchOffers as unknown as DispatchOfferRepositoryPort,
      {} as unknown as NotificationPort,
      {} as unknown as DataSource,
      {} as unknown as FleetDispatchLockService,
      {
        assertPuedeAsignar: jest.fn().mockResolvedValue(undefined),
      } as unknown as import('./domain/ports/truck-load-gate.port').TruckLoadGatePort,
      {} as never,
      {} as never,
    );
  });

  it('pedido inexistente: 404, no un 2xx con rejected: false', async () => {
    orders.findByIdFull.mockResolvedValue(null);
    await expect(
      service.rejectOffer(PEDIDO, CHOFER_USER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ACCEPTED asignado a mano (sin oferta OFFERED suya): NO cambia el pedido, avisa a los admins', async () => {
    orders.findByIdFull.mockResolvedValue(pedidoAsignadoManualmente());
    dispatchOffers.hasActiveOffer.mockResolvedValue(false);

    const result = await service.rejectOffer(PEDIDO, CHOFER_USER_ID);

    expect(result).toEqual({ rejected: true });
    expect(dispatchOffers.hasActiveOffer).toHaveBeenCalledWith(
      PEDIDO,
      CHOFER_USER_ID,
    );
    expect(dispatchOrchestrator.onDriverRejected).not.toHaveBeenCalled();
    expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
      'order:assignment-declined',
      {
        orderId: PEDIDO,
        driverId: CHOFER_USER_ID,
        driverName: 'Chofer Test',
        distributorId: DISTRIBUIDORA,
      },
      DISTRIBUIDORA,
    );
  });

  it('con una oferta OFFERED real activa DE ESTE chofer, NO avisa a admins: cierra la oferta como siempre', async () => {
    orders.findByIdFull.mockResolvedValue(pedidoAsignadoManualmente());
    dispatchOffers.hasActiveOffer.mockResolvedValue(true);

    await service.rejectOffer(PEDIDO, CHOFER_USER_ID);

    expect(dispatch.notifyAdmins).not.toHaveBeenCalled();
    expect(dispatchOrchestrator.onDriverRejected).toHaveBeenCalled();
  });

  it('un chofer que no es el asignado no puede "declinar" el pedido de otro', async () => {
    orders.findByIdFull.mockResolvedValue(pedidoAsignadoManualmente());
    dispatchOffers.hasActiveOffer.mockResolvedValue(false);

    await service.rejectOffer(PEDIDO, 'otro-chofer');

    // No es "su" asignación manual: cae al camino de siempre (oferta real),
    // que es un no-op si ese chofer nunca tuvo una oferta para este pedido.
    expect(dispatch.notifyAdmins).not.toHaveBeenCalled();
    expect(dispatchOrchestrator.onDriverRejected).toHaveBeenCalled();
  });

  it('un pedido PENDING (oferta normal en curso) sigue el camino de siempre', async () => {
    orders.findByIdFull.mockResolvedValue({
      orderId: PEDIDO,
      status: OrderStatus.PENDING,
      delivery: null,
    } as unknown as Order);

    await service.rejectOffer(PEDIDO, CHOFER_USER_ID);

    expect(dispatchOffers.hasActiveOffer).not.toHaveBeenCalled();
    expect(dispatch.notifyAdmins).not.toHaveBeenCalled();
    expect(dispatchOrchestrator.onDriverRejected).toHaveBeenCalled();
  });

  it('reject TARDÍO sobre un pedido ya aceptado por una oferta real: sin efecto (no-op de onDriverRejected)', async () => {
    // El pedido quedó ACCEPTED por una oferta real (no manual): la oferta de
    // ESTE chofer ya se cerró como ACCEPTED al aceptarse, así que no hay
    // ninguna OFFERED suya vigente — pero tampoco es "su" asignación manual
    // porque la condición de abajo exige que el pedido esté asignado A ÉL.
    orders.findByIdFull.mockResolvedValue({
      orderId: PEDIDO,
      distributorId: DISTRIBUIDORA,
      status: OrderStatus.ACCEPTED,
      delivery: { userId: 'otro-chofer-que-aceptó', user: null },
    } as unknown as Order);

    await service.rejectOffer(PEDIDO, CHOFER_USER_ID);

    expect(dispatch.notifyAdmins).not.toHaveBeenCalled();
    // onDriverRejected cierra la oferta OFFERED de este chofer si hubiera
    // alguna; si no hay (porque llegó tarde), es un no-op de ese método, no
    // de rejectOffer.
    expect(dispatchOrchestrator.onDriverRejected).toHaveBeenCalled();
  });
});
