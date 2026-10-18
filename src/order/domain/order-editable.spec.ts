import {
  OrderDeliveryMode,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
import { esEditable, motivoNoEditable } from './order-editable';

const pedido = {
  status: OrderStatus.PENDING,
  deliveryId: null,
  paymentMethod: PaymentMethod.CASH,
  paymentStatus: PaymentStatus.PENDING,
};

describe('motivoNoEditable', () => {
  it('un pedido express no se edita: EXPRESS', () => {
    const express = { ...pedido, deliveryMode: OrderDeliveryMode.EXPRESS };
    expect(motivoNoEditable(express)?.motivo).toBe('EXPRESS');
    expect(esEditable(express)).toBe(false);
    expect(
      esEditable({ ...pedido, deliveryMode: OrderDeliveryMode.STANDARD }),
    ).toBe(true);
  });

  it('pendiente, sin chofer y sin pago en curso: editable', () => {
    expect(motivoNoEditable(pedido)).toBeNull();
    expect(esEditable(pedido)).toBe(true);
  });

  it('por estado o chofer: ESTADO', () => {
    expect(
      motivoNoEditable({ ...pedido, status: OrderStatus.ACCEPTED })?.motivo,
    ).toBe('ESTADO');
    expect(motivoNoEditable({ ...pedido, deliveryId: 'x' })?.motivo).toBe(
      'ESTADO',
    );
  });

  it('por pago online: PAGO_ONLINE', () => {
    expect(
      motivoNoEditable({ ...pedido, paymentMethod: PaymentMethod.MERCADOPAGO })
        ?.motivo,
    ).toBe('PAGO_ONLINE');
    expect(
      motivoNoEditable({ ...pedido, paymentStatus: PaymentStatus.PAID })
        ?.motivo,
    ).toBe('PAGO_ONLINE');
  });
});
