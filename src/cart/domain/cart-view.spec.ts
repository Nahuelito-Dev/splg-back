import { armarVista, ItemDelCarrito } from './cart-view';

const item = (parcial: Partial<ItemDelCarrito> = {}): ItemDelCarrito => ({
  cartItemId: 'i1',
  gasCylinderId: 'g1',
  type: '10kg',
  quantity: 2,
  savedUnitPrice: 1000,
  currentUnitPrice: 1000,
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
      item({ quantity: 3, savedUnitPrice: 1000, currentUnitPrice: 1200 }),
    ]);
    expect(vista.total).toBe(3600);
    expect(vista.items[0].subtotal).toBe(3600);
    expect(vista.items[0].priceDifference).toBe(200);
    expect(vista.hasPriceChanges).toBe(true);
  });

  it('informa la baja de precio con signo negativo', () => {
    const vista = armarVista([
      item({ savedUnitPrice: 1000, currentUnitPrice: 900 }),
    ]);
    expect(vista.items[0].priceDifference).toBe(-100);
  });

  it('suma con aritmética decimal exacta', () => {
    const vista = armarVista([
      item({ quantity: 3, currentUnitPrice: 0.1, savedUnitPrice: 0.1 }),
    ]);
    expect(vista.total).toBe(0.3);
  });

  it('un tipo dado de baja se muestra pero no suma al total ni a las unidades', () => {
    const vista = armarVista([
      item({ cartItemId: 'a', quantity: 1, currentUnitPrice: 500 }),
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
});
