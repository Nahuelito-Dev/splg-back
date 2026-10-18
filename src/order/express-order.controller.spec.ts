import { ExpressOrderController } from './express-order.controller';
import { RoleType } from '../common/constants/role-type.enum';
import { PaymentMethod } from './entities/order.entity';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { OrderMapper } from './order.mapper';
import type { Order } from './entities/order.entity';

const cliente = {
  user_id: 'cli-1',
  role: RoleType.CUSTOMER,
} as AuthenticatedUser;

describe('ExpressOrderController', () => {
  let options: { execute: jest.Mock };
  let purchase: { preview: jest.Mock; buy: jest.Mock };
  let controller: ExpressOrderController;

  beforeEach(() => {
    options = { execute: jest.fn().mockResolvedValue({ options: [] }) };
    purchase = {
      preview: jest.fn().mockResolvedValue({ available: true }),
      buy: jest.fn(),
    };
    controller = new ExpressOrderController(
      options as never,
      purchase as never,
    );
  });

  it('GET /orders/delivery-options pasa el usuario y la distribuidora', async () => {
    await controller.options({ addressId: 'dir-1' }, cliente, 'dist-1');
    expect(options.execute).toHaveBeenCalledWith(
      { addressId: 'dir-1' },
      'dist-1',
      { userId: 'cli-1', role: RoleType.CUSTOMER },
    );
  });

  it('POST /orders/express/quote delega en la vista previa', async () => {
    const r = await controller.preview(
      { paymentMethod: PaymentMethod.CASH },
      cliente,
      'dist-1',
    );
    expect(purchase.preview).toHaveBeenCalledWith(
      { paymentMethod: PaymentMethod.CASH },
      'cli-1',
      'dist-1',
    );
    expect(r).toEqual({ available: true });
  });

  it('POST /orders/express crea el pedido y devuelve el payment_url del checkout', async () => {
    const order = { orderId: 'ord-1' } as Order;
    purchase.buy.mockResolvedValue({ order, paymentUrl: 'https://mp.test/x' });
    jest.spyOn(OrderMapper, 'toDto').mockReturnValue({ id: 'ord-1' } as never);

    const r = await controller.buy(
      { paymentMethod: PaymentMethod.MERCADOPAGO },
      cliente,
      'dist-1',
    );

    expect(purchase.buy).toHaveBeenCalledWith(
      { paymentMethod: PaymentMethod.MERCADOPAGO },
      'cli-1',
      'dist-1',
    );
    expect(r.paymentUrl).toBe('https://mp.test/x');
  });
});
