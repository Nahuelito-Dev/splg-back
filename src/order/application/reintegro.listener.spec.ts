import { EVENTO_NOTIFICAR_ADMIN } from '../../common/events/notificar-admin.event';
import { ReintegroListener } from './reintegro.listener';
import {
  PagoReintegradoEvent,
  ReintegroFallidoEvent,
} from '../../payments/domain/events/reintegro.events';
import { RefundKind } from '../../payments/domain/payment.enums';

describe('ReintegroListener (CU-168)', () => {
  let orders: { findForRefund: jest.Mock };
  let realtime: { notifyCustomer: jest.Mock; notifyAdmins: jest.Mock };
  let notifications: { sendOrderNoticePush: jest.Mock };
  let events: { emit: jest.Mock };
  let listener: ReintegroListener;

  const reintegro = {
    orderId: 'ord-1234567890',
    refundId: 'ref-1',
    paymentId: 'pay-1',
    distributorId: 'dist-1',
    kind: RefundKind.FULL,
    amount: 3000,
    attempts: 1,
  };

  beforeEach(() => {
    orders = {
      findForRefund: jest.fn().mockResolvedValue({ customerId: 'cus-1' }),
    };
    realtime = { notifyCustomer: jest.fn(), notifyAdmins: jest.fn() };
    notifications = {
      sendOrderNoticePush: jest.fn().mockResolvedValue(undefined),
    };
    events = { emit: jest.fn() };
    listener = new ReintegroListener(
      orders as never,
      realtime as never,
      notifications as never,
      events as never,
    );
  });

  it('un pago reintegrado se avisa al cliente y al panel de su distribuidora', async () => {
    await listener.onReintegrado(new PagoReintegradoEvent(reintegro));

    expect(realtime.notifyCustomer).toHaveBeenCalledWith(
      'cus-1',
      'order:payment-refunded',
      expect.objectContaining({ orderId: 'ord-1234567890', amount: 3000 }),
    );
    expect(realtime.notifyAdmins).toHaveBeenCalledWith(
      'order:payment-refunded',
      expect.objectContaining({ distributorId: 'dist-1' }),
      'dist-1',
    );
    expect(notifications.sendOrderNoticePush).toHaveBeenCalledWith(
      'cus-1',
      'ord-1234567890',
      expect.objectContaining({ event: 'PAYMENT_REFUNDED' }),
    );
  });

  it('un pedido que ya no existe no avisa a nadie', async () => {
    orders.findForRefund.mockResolvedValue(null);

    await listener.onReintegrado(new PagoReintegradoEvent(reintegro));

    expect(realtime.notifyCustomer).not.toHaveBeenCalled();
  });

  it('si el aviso falla no propaga el error', async () => {
    realtime.notifyCustomer.mockImplementation(() => {
      throw new Error('socket caído');
    });

    await expect(
      listener.onReintegrado(new PagoReintegradoEvent(reintegro)),
    ).resolves.toBeUndefined();
  });

  it('una devolución fallida avisa sólo al panel, con el motivo', () => {
    listener.onFallido(new ReintegroFallidoEvent(reintegro, 'saldo'));

    expect(realtime.notifyAdmins).toHaveBeenCalledWith(
      'order:refund-failed',
      expect.objectContaining({ orderId: 'ord-1234567890', reason: 'saldo' }),
      'dist-1',
    );
    expect(realtime.notifyCustomer).not.toHaveBeenCalled();
  });

  it('una devolución fallida pide el aviso de la bandeja con el reintegro como clave', () => {
    listener.onFallido(new ReintegroFallidoEvent(reintegro, 'saldo'));

    expect(events.emit).toHaveBeenCalledWith(
      EVENTO_NOTIFICAR_ADMIN,
      expect.objectContaining({
        distributorId: 'dist-1',
        kind: 'refund_failed',
        dedupeKey: 'refund-failed:ref-1:1',
        link: { entity: 'order', id: 'ord-1234567890' },
        email: false,
      }),
    );
  });

  it('si el reintento vuelve a fallar, el aviso es nuevo (otra dedupeKey)', () => {
    listener.onFallido(
      new ReintegroFallidoEvent({ ...reintegro, attempts: 2 }, 'rechazado'),
    );
    expect(events.emit).toHaveBeenLastCalledWith(
      EVENTO_NOTIFICAR_ADMIN,
      expect.objectContaining({ dedupeKey: 'refund-failed:ref-1:2' }),
    );
  });

  it('un reintegro sin distribuidora no pide aviso a la bandeja', () => {
    listener.onFallido(
      new ReintegroFallidoEvent({ ...reintegro, distributorId: null }, 'x'),
    );

    expect(events.emit).not.toHaveBeenCalled();
  });

  it('si el aviso del fallo falla no propaga el error', () => {
    realtime.notifyAdmins.mockImplementation(() => {
      throw new Error('socket caído');
    });

    expect(() =>
      listener.onFallido(new ReintegroFallidoEvent(reintegro, 'saldo')),
    ).not.toThrow();
  });
});
