import Decimal from 'decimal.js';
import { CreateOrderUseCase } from './create-order.use-case';
import { OrderPricingService } from '../domain/order-pricing.service';
import { CoverageZonePricingService } from '../../coverage-zone/coverage-zone-pricing.service';
import { renglonesDelCheckout } from '../domain/checkout-items';
import { armarVista } from '../../cart/domain/cart-view';
import { PaymentMethod } from '../entities/order.entity';
import type { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';

/**
 * Un mismo pedido por todos los caminos de plata: carrito, cotización/alta
 * (`valorizarRenglon` + `calcularTotales`) y renglones que se mandan a la
 * pasarela tienen que dar los mismos montos al centavo, con las promociones
 * cargadas en cada producto.
 */
const pricing = new OrderPricingService();
const useCase = Object.assign(Object.create(CreateOrderUseCase.prototype), {
  pricing,
  coverageZonePricing: new CoverageZonePricingService(),
  orderItemRepository: { create: (x: object) => x },
}) as CreateOrderUseCase;

const producto = (
  id: string,
  price: number,
  promotions: { quantity: number; discountPercentage: number }[],
): GasCylinder =>
  ({
    gasCylinderId: id,
    type: id,
    price,
    distributorId: 'd1',
    promotions,
  }) as unknown as GasCylinder;

// Varias promos, una sola, ninguna y una cuya promo se dio de baja (el
// catálogo no la trae: queda sin promociones).
const CATALOGO = [
  producto('10kg', 14900, [
    { quantity: 2, discountPercentage: 5 },
    { quantity: 4, discountPercentage: 12 },
  ]),
  producto('15kg', 21350.5, [{ quantity: 3, discountPercentage: 7.5 }]),
  producto('45kg', 61000, []),
  producto('5kg', 7333.33, []),
];

const pedidos = [
  [1, 1, 1, 1],
  [2, 1, 1, 1],
  [3, 3, 2, 3],
  [4, 2, 1, 7],
  [9, 5, 1, 1],
];

describe('coherencia de montos: carrito, cotización, pedido y pasarela', () => {
  describe.each(pedidos)('cantidades %i / %i / %i / %i', (...cantidades) => {
    const items = CATALOGO.map((g, i) => ({
      gasCylinderId: g.gasCylinderId,
      quantity: cantidades[i],
    }));
    const renglones = CATALOGO.map((g, i) =>
      useCase.valorizarRenglon(g, items[i], 'd1'),
    );
    const subtotalPedido = renglones.reduce(
      (s, r) => s.plus(r.subtotal),
      new Decimal(0),
    );

    it('el carrito da los mismos renglones y subtotal que el pedido', () => {
      const vista = armarVista(
        CATALOGO.map((g, i) => ({
          cartItemId: g.gasCylinderId,
          gasCylinderId: g.gasCylinderId,
          type: g.type,
          quantity: cantidades[i],
          savedUnitPrice: g.price,
          listUnitPrice: g.price,
          promotions: g.promotions,
          available: true,
          hasEnoughStock: true,
        })),
        pricing,
      );
      vista.items.forEach((r, i) => {
        expect(r.currentUnitPrice).toBe(renglones[i].orderItem.unitPrice);
        expect(r.subtotal).toBe(renglones[i].orderItem.subtotal);
      });
      expect(vista.total).toBe(subtotalPedido.toNumber());
    });

    it.each([
      PaymentMethod.CASH,
      PaymentMethod.TRANSFER,
      PaymentMethod.MERCADOPAGO,
    ])('%s: la pasarela cobra exactamente el total guardado', (medio) => {
      const { totalAmount, paymentSurchargeAmount } = useCase.calcularTotales(
        subtotalPedido,
        null,
        medio,
      );
      const renglonesPasarela = renglonesDelCheckout(
        renglones.map((r) => r.checkoutItem),
        { zona: 0, online: paymentSurchargeAmount, express: 0 },
      );
      const cobrado = renglonesPasarela.reduce(
        (s, r) => s.plus(new Decimal(r.unitPrice).times(r.quantity)),
        new Decimal(0),
      );
      expect(cobrado.toFixed(2)).toBe(totalAmount.toFixed(2));
      // cada renglón guarda cantidad × precio unitario = subtotal
      renglones.forEach((r) =>
        expect(
          new Decimal(r.orderItem.unitPrice)
            .times(r.orderItem.quantity)
            .toNumber(),
        ).toBe(r.orderItem.subtotal),
      );
    });
  });

  it('el caso del bug: 2 y 4 garrafas de 10 kg con la promo cargada', () => {
    const g = CATALOGO[0];
    const dos = useCase.valorizarRenglon(
      g,
      { gasCylinderId: '10kg', quantity: 2 },
      'd1',
    );
    const cuatro = useCase.valorizarRenglon(
      g,
      { gasCylinderId: '10kg', quantity: 4 },
      'd1',
    );
    expect(dos.subtotal.toNumber()).toBe(28310);
    expect(cuatro.subtotal.toNumber()).toBe(52448);
  });
});
