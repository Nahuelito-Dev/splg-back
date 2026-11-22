import { PaymentMethod } from '../../order/entities/order.entity';
import type { CompraEntregadaRef } from '../../order/lookup/order-lookup.service';
import {
  habitosDe,
  kilosDeLaCompra,
  comoEstimacion,
} from './habitos-de-compra';

const compra = (
  parcial: Partial<CompraEntregadaRef> = {},
): CompraEntregadaRef => ({
  orderId: 'o',
  customerId: 'c1',
  deliveredAt: new Date('2026-10-01T12:00:00Z'),
  addressId: 'a1',
  timeSlotId: null,
  paymentMethod: PaymentMethod.CASH,
  items: [{ gasCylinderId: 'g10', quantity: 1, weightKg: 10 }],
  ...parcial,
});

describe('habitosDe', () => {
  it('sugiere los renglones de la última compra', () => {
    const h = habitosDe([
      compra({ items: [{ gasCylinderId: 'g45', quantity: 1, weightKg: 45 }] }),
      compra({
        items: [
          { gasCylinderId: 'g10', quantity: 2, weightKg: 10 },
          { gasCylinderId: 'g15', quantity: 1, weightKg: 15 },
        ],
      }),
    ]);
    expect(h.items).toEqual([
      { gasCylinderId: 'g10', quantity: 2 },
      { gasCylinderId: 'g15', quantity: 1 },
    ]);
  });

  it('elige la dirección y la franja que más usó; en empate, la más reciente', () => {
    const h = habitosDe([
      compra({ addressId: 'a1', timeSlotId: 't1' }),
      compra({ addressId: 'a2', timeSlotId: 't2' }),
      compra({ addressId: 'a2', timeSlotId: null }),
      compra({ addressId: 'a1', timeSlotId: 't2' }),
    ]);
    expect(h.addressId).toBe('a1');
    expect(h.timeSlotId).toBe('t2');
  });

  it('sin franja en ninguna compra no sugiere franja', () => {
    expect(habitosDe([compra(), compra()]).timeSlotId).toBeNull();
  });

  it('sugiere el medio de pago más usado y nunca la cuenta corriente', () => {
    const h = habitosDe([
      compra({ paymentMethod: PaymentMethod.ACCOUNT }),
      compra({ paymentMethod: PaymentMethod.ACCOUNT }),
      compra({ paymentMethod: PaymentMethod.MERCADOPAGO }),
    ]);
    expect(h.paymentMethod).toBe(PaymentMethod.MERCADOPAGO);
    expect(
      habitosDe([compra({ paymentMethod: PaymentMethod.ACCOUNT })])
        .paymentMethod,
    ).toBe(PaymentMethod.CASH);
  });

  it('una compra vieja por transferencia no cuenta como hábito: la transferencia ya no se acepta', () => {
    expect(
      habitosDe([
        compra({ paymentMethod: PaymentMethod.TRANSFER }),
        compra({ paymentMethod: PaymentMethod.TRANSFER }),
        compra({ paymentMethod: PaymentMethod.MERCADOPAGO }),
      ]).paymentMethod,
    ).toBe(PaymentMethod.MERCADOPAGO);
    expect(
      habitosDe([compra({ paymentMethod: PaymentMethod.TRANSFER })])
        .paymentMethod,
    ).toBe(PaymentMethod.CASH);
  });
});

describe('kilos de una compra', () => {
  it('suma cantidad por peso de cada renglón', () => {
    const c = compra({
      items: [
        { gasCylinderId: 'g10', quantity: 2, weightKg: 10 },
        { gasCylinderId: 'g45', quantity: 1, weightKg: 45 },
      ],
    });
    expect(kilosDeLaCompra(c)).toBe(65);
    expect(comoEstimacion(c)).toEqual({ deliveredAt: c.deliveredAt, kg: 65 });
  });
});
