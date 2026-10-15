import { ForbiddenException } from '@nestjs/common';
import { OrderService } from './order.service';
import { Order, OrderStatus } from './entities/order.entity';
import type { Repository } from 'typeorm';
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
import type { DataSource } from 'typeorm';
import type { FleetDispatchLockService } from '../fleet/fleet-dispatch-lock.service';

/**
 * `PATCH /orders/:id/location` (H-91). La posición del chofer va al radar y no
 * al pedido: antes pisaba el punto de entrega, y un pedido que volvía a
 * despacharse buscaba choferes cerca del chofer anterior y no del cliente.
 */
describe('OrderService · posición del chofer', () => {
  const PEDIDO = 'f1f1f1f1-0000-4000-8000-000000000001';
  const DELIVERY = 'd1d1d1d1-0000-4000-8000-000000000003';
  const DESTINO = { type: 'Point' as const, coordinates: [-55.9, -27.4] };

  let dispatch: { reportDriverLocation: jest.Mock };
  let repo: { save: jest.Mock };
  let deliveries: { buscarPorIdOUsuario: jest.Mock };
  let service: OrderService;
  let pedido: Order;

  beforeEach(() => {
    pedido = {
      orderId: PEDIDO,
      deliveryId: DELIVERY,
      status: OrderStatus.ON_THE_WAY,
      deliveryPoint: { ...DESTINO },
    } as unknown as Order;
    dispatch = { reportDriverLocation: jest.fn().mockResolvedValue(undefined) };
    repo = { save: jest.fn() };
    deliveries = { buscarPorIdOUsuario: jest.fn() };
    service = new OrderService(
      repo as unknown as Repository<Order>,
      deliveries as unknown as DeliveryService,
      dispatch as unknown as RealtimeDispatchPort,
      {} as unknown as OrderRepositoryPort,
      {} as unknown as CreateOrderUseCase,
      {} as unknown as UpdateOrderStatusUseCase,
      {} as unknown as CancelOrderUseCase,
      {} as unknown as ConfirmDeliveryUseCase,
      {} as unknown as DispatchOrchestratorService,
      {} as unknown as DispatchOfferRepositoryPort,
      {} as unknown as NotificationPort,
      {} as unknown as DataSource,
      {} as unknown as FleetDispatchLockService,
      {
        assertPuedeAsignar: jest.fn().mockResolvedValue(undefined),
      } as unknown as import('./domain/ports/truck-load-gate.port').TruckLoadGatePort,
      {} as never,
      {} as never,
    );
    jest.spyOn(service, 'findOne').mockResolvedValue(pedido);
  });

  it('registra la posición en el radar y no toca el punto de entrega', async () => {
    deliveries.buscarPorIdOUsuario.mockResolvedValue({ deliveryId: DELIVERY });

    const result = await service.updateLocation(
      PEDIDO,
      '-27.3',
      '-55.8',
      'user-chofer',
    );

    expect(dispatch.reportDriverLocation).toHaveBeenCalledWith(
      'user-chofer',
      -27.3,
      -55.8,
    );
    expect(repo.save).not.toHaveBeenCalled();
    expect(result.deliveryPoint).toEqual(DESTINO);
  });

  it('rechaza al chofer que no tiene el pedido asignado', async () => {
    deliveries.buscarPorIdOUsuario.mockResolvedValue({
      deliveryId: 'otro-chofer',
    });

    await expect(
      service.updateLocation(PEDIDO, '-27.3', '-55.8', 'user-ajeno'),
    ).rejects.toThrow(ForbiddenException);
    expect(dispatch.reportDriverLocation).not.toHaveBeenCalled();
  });
});
