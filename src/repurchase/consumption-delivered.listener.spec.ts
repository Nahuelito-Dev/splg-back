import { PaymentMethod } from '../order/entities/order.entity';
import { PedidoEntregadoEvent } from '../order/domain/events/pedido-entregado.event';
import { ConsumptionDeliveredListener } from './consumption-delivered.listener';
import { ConsumptionService } from './consumption.service';

const evento = new PedidoEntregadoEvent(
  'o1',
  'd1',
  'ch1',
  'u1',
  PaymentMethod.CASH,
  1000,
  new Date('2026-10-31T12:00:00Z'),
);

describe('ConsumptionDeliveredListener', () => {
  let consumption: { recalcularTrasEntrega: jest.Mock };
  let listener: ConsumptionDeliveredListener;

  beforeEach(() => {
    consumption = {
      recalcularTrasEntrega: jest.fn().mockResolvedValue(undefined),
    };
    listener = new ConsumptionDeliveredListener(
      consumption as unknown as ConsumptionService,
    );
  });

  it('al entregarse un pedido recalcula la estimación del cliente', async () => {
    await listener.handle(evento);
    expect(consumption.recalcularTrasEntrega).toHaveBeenCalledWith('u1');
  });

  it('si falla no bloquea la entrega', async () => {
    consumption.recalcularTrasEntrega.mockRejectedValue(
      new Error('base caída'),
    );
    await expect(listener.handle(evento)).resolves.toBeUndefined();
  });
});
