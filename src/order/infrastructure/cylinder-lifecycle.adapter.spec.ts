import { EntityManager } from 'typeorm';
import { DeliverOrderCylindersUseCase } from '../../cylinder/application/deliver-order-cylinders.use-case';
import { CylinderLifecycleAdapter } from './cylinder-lifecycle.adapter';

describe('CylinderLifecycleAdapter', () => {
  it('resuelve "el pedido se entregó" con el caso de uso de envases, en la transacción del pedido', async () => {
    const entregar = { execute: jest.fn().mockResolvedValue(2) };
    const adapter = new CylinderLifecycleAdapter(
      entregar as unknown as DeliverOrderCylindersUseCase,
    );
    const manager = {} as EntityManager;

    await expect(
      adapter.onOrderDelivered('ord-1', 'dist-1', manager),
    ).resolves.toBe(2);

    expect(entregar.execute).toHaveBeenCalledWith('ord-1', 'dist-1', manager);
  });
});
