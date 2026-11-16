import Decimal from 'decimal.js';
import { armarVista as armar, ItemDelCarrito } from './cart-view';
import { OrderPricingService } from '../../order/domain/order-pricing.service';

const pricing = new OrderPricingService();
const armarVista = (items: ItemDelCarrito[]) => armar(items, pricing);

const item = (parcial: Partial<ItemDelCarrito> = {}): ItemDelCarrito => ({
  cartItemId: 'i1',
  gasCylinderId: 'g1',
  type: '10kg',
  quantity: 2,
  savedUnitPrice: 1000,
  listUnitPrice: 1000,
  available: true,
  hasEnoughStock: true,
  ...parcial,
});

describe('armarVista', () => {
  it('un carrito vacío vale cero y no avisa nada', () => {
    expect(armarVista([])).toEqual({
      items: [],
      totalUnits: 0,
      total: 0,
      hasPriceChanges: false,
      hasUnavailableItems: false,
    });
  });

  it('el total sale del precio vigente, no del guardado', () => {
    const vista = armarVista([
      item({ quantity: 3, savedUnitPrice: 1000, listUnitPrice: 1200 }),
    ]);
    expect(vista.total).toBe(3600);
    expect(vista.items[0].subtotal).toBe(3600);
    expect(vista.items[0].priceDifference).toBe(200);
    expect(vista.hasPriceChanges).toBe(true);
  });

  it('informa la baja de precio con signo negativo', () => {
    const vista = armarVista([
      item({ savedUnitPrice: 1000, listUnitPrice: 900 }),
    ]);
    expect(vista.items[0].priceDifference).toBe(-100);
  });

  it('suma con aritmética decimal exacta', () => {
    const vista = armarVista([
      item({ quantity: 3, listUnitPrice: 0.1, savedUnitPrice: 0.1 }),
    ]);
    expect(vista.total).toBe(0.3);
  });

  it('un tipo dado de baja se muestra pero no suma al total ni a las unidades', () => {
    const vista = armarVista([
      item({ cartItemId: 'a', quantity: 1, listUnitPrice: 500 }),
      item({ cartItemId: 'b', quantity: 4, available: false }),
    ]);
    expect(vista.items).toHaveLength(2);
    expect(vista.items[1].subtotal).toBe(0);
    expect(vista.total).toBe(500);
    expect(vista.totalUnits).toBe(1);
    expect(vista.hasUnavailableItems).toBe(true);
  });

  it('sin cambios de precio no marca diferencias', () => {
    expect(armarVista([item()]).hasPriceChanges).toBe(false);
  });

  describe('promociones por volumen', () => {
    const promos = [
      { quantity: 2, discountPercentage: 5 },
      { quantity: 4, discountPercentage: 12 },
    ];
    const garrafa10 = (quantity: number) =>
      armarVista([
        item({
          quantity,
          listUnitPrice: 14900,
          savedUnitPrice: 14900,
          promotions: promos,
        }),
      ]);

    it('debajo del primer umbral cobra el precio de lista', () => {
      const r = garrafa10(1).items[0];
      expect(r.currentUnitPrice).toBe(14900);
      expect(r.discountPercentage).toBe(0);
      expect(r.subtotal).toBe(14900);
    });

    it('en el umbral exacto aplica esa promoción', () => {
      const v = garrafa10(2);
      expect(v.items[0].currentUnitPrice).toBe(14155);
      expect(v.items[0].promoUnitPrice).toBe(14155);
      expect(v.items[0].listUnitPrice).toBe(14900);
      expect(v.items[0].discountPercentage).toBe(5);
      expect(v.total).toBe(28310);
    });

    it('entre umbrales mantiene la promoción del umbral alcanzado', () => {
      const v = garrafa10(3);
      expect(v.items[0].discountPercentage).toBe(5);
      expect(v.total).toBe(42465);
    });

    it('por encima del umbral más alto aplica la mayor', () => {
      const v = garrafa10(4);
      expect(v.items[0].currentUnitPrice).toBe(13112);
      expect(v.items[0].discountPercentage).toBe(12);
      expect(v.total).toBe(52448);
      expect(garrafa10(9).items[0].discountPercentage).toBe(12);
    });

    it('la promoción no cuenta como cambio de precio', () => {
      expect(garrafa10(4).hasPriceChanges).toBe(false);
      expect(garrafa10(4).items[0].priceDifference).toBe(0);
    });

    it('un producto sin promociones cobra lista, con null o vacío', () => {
      const v = armarVista([
        item({
          cartItemId: 'a',
          quantity: 5,
          listUnitPrice: 1000,
          promotions: null,
        }),
        item({
          cartItemId: 'b',
          quantity: 5,
          listUnitPrice: 2000,
          promotions: [],
        }),
      ]);
      expect(v.total).toBe(15000);
    });

    it('cada producto usa SUS promociones y el total las suma', () => {
      const v = armarVista([
        item({
          cartItemId: 'a',
          quantity: 2,
          listUnitPrice: 14900,
          promotions: promos,
        }),
        item({
          cartItemId: 'b',
          quantity: 3,
          listUnitPrice: 21000,
          promotions: [{ quantity: 3, discountPercentage: 10 }],
        }),
        item({ cartItemId: 'c', quantity: 6, listUnitPrice: 500 }),
      ]);
      expect(v.items.map((r) => r.subtotal)).toEqual([28310, 56700, 3000]);
      expect(v.total).toBe(88010);
    });

    it('coincide con OrderPricingService.priceItem para cualquier cantidad', () => {
      for (let q = 1; q <= 12; q++) {
        const esperado = pricing.priceItem(14900, promos, q);
        const r = garrafa10(q).items[0];
        expect(new Decimal(r.currentUnitPrice).eq(esperado.unitPrice)).toBe(
          true,
        );
        expect(new Decimal(r.subtotal).eq(esperado.subtotal)).toBe(true);
      }
    });
  });
});
