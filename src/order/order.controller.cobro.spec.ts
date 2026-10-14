import { Logger } from '@nestjs/common';
import { OrderController } from './order.controller';
import { Order, OrderStatus, PaymentStatus } from './entities/order.entity';
import { RoleType } from '../common/constants/role-type.enum';
import { conRespuestaVigilada } from '../common/interceptors/respuesta-incompleta';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

/**
 * Tras un cobro confirmado, una falla al releer el pedido no puede devolver un
 * 500: el reintento con la misma `Idempotency-Key` repetiría la operación.
 */
describe('OrderController · respuesta tras el cobro', () => {
  const guardado = {
    orderId: 'o1',
    status: OrderStatus.DELIVERED,
    paymentStatus: PaymentStatus.PAID,
    totalAmount: 100,
    items: [],
  } as unknown as Order;
  const usuario = {
    user_id: 'u1',
    role: RoleType.DELIVERY,
  } as unknown as AuthenticatedUser;

  let orderService: { assertDeLaDistribuidora: jest.Mock; getOne: jest.Mock };
  let cash: Record<string, jest.Mock>;
  let controller: OrderController;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    orderService = {
      assertDeLaDistribuidora: jest.fn().mockResolvedValue(undefined),
      getOne: jest.fn().mockRejectedValue(new Error('conexión caída')),
    };
    const resultado = { order: guardado, changed: true, extra: undefined };
    cash = {
      confirmReceived: jest.fn().mockResolvedValue(resultado),
      resolveUnpaid: jest.fn().mockResolvedValue(resultado),
      registerCashByAdmin: jest.fn().mockResolvedValue(resultado),
      confirmTransfer: jest.fn().mockResolvedValue(resultado),
    };
    controller = new OrderController(
      orderService as never,
      {} as never,
      {} as never,
      cash as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('cash-received responde con el pedido guardado si la relectura falla, y avisa que está incompleta', async () => {
    const { valor: r, incompleta } = await conRespuestaVigilada(() =>
      controller.confirmCashReceived(usuario, 'o1', 'd1'),
    );
    expect(r).toMatchObject({ id: 'o1', paymentStatus: PaymentStatus.PAID });
    expect(incompleta).toBe(true);
  });

  it('con la relectura sana no se marca incompleta', async () => {
    orderService.getOne.mockResolvedValue({ id: 'o1' });
    const { incompleta } = await conRespuestaVigilada(() =>
      controller.confirmCashReceived(usuario, 'o1', 'd1'),
    );
    expect(incompleta).toBe(false);
  });

  it('resolve-unpaid también, y conserva alreadyResolved', async () => {
    const r = await controller.resolveUnpaid(
      usuario,
      'o1',
      { resolution: 'paid', note: 'x' },
      'd1',
    );
    expect(r).toMatchObject({ id: 'o1', alreadyResolved: false });
  });

  it('register-cash y confirm-transfer también', async () => {
    const motivo = { reason: 'motivo suficiente' };
    await expect(
      controller.registerCash(usuario, 'o1', motivo, 'd1'),
    ).resolves.toMatchObject({ id: 'o1' });
    await expect(
      controller.confirmTransfer(
        usuario,
        'o1',
        { ...motivo, received: true },
        'd1',
      ),
    ).resolves.toMatchObject({ id: 'o1' });
  });
});
