import { PurchaseOrderStatus as E } from './purchase.enums';
import {
  costoPromedioPonderado,
  costoPromedioAlAnular,
  estadoSegunRecibido,
  excesosDeRecepcion,
  pendienteDe,
  totalDe,
  validarEditable,
  validarRenglonesDeRecepcion,
  validarTransicion,
} from './purchase-rules';

describe('transiciones de la orden de compra', () => {
  it.each([
    [E.DRAFT, E.SENT],
    [E.DRAFT, E.CANCELLED],
    [E.SENT, E.PARTIALLY_RECEIVED],
    [E.SENT, E.RECEIVED],
    [E.SENT, E.CANCELLED],
    [E.PARTIALLY_RECEIVED, E.RECEIVED],
    [E.RECEIVED, E.PARTIALLY_RECEIVED],
    [E.RECEIVED, E.SENT],
    [E.PARTIALLY_RECEIVED, E.CLOSED_SHORT],
    [E.PARTIALLY_RECEIVED, E.SENT],
  ])('%s a %s es válida', (desde, hacia) => {
    expect(() => validarTransicion(desde, hacia)).not.toThrow();
  });

  it.each([
    [E.DRAFT, E.RECEIVED],
    [E.DRAFT, E.PARTIALLY_RECEIVED],
    [E.SENT, E.DRAFT],
    [E.PARTIALLY_RECEIVED, E.CANCELLED],
    [E.RECEIVED, E.CANCELLED],
    [E.CANCELLED, E.SENT],
    [E.CANCELLED, E.DRAFT],
    [E.SENT, E.CLOSED_SHORT],
    [E.DRAFT, E.CLOSED_SHORT],
    [E.RECEIVED, E.CLOSED_SHORT],
    [E.CLOSED_SHORT, E.SENT],
    [E.CLOSED_SHORT, E.PARTIALLY_RECEIVED],
    [E.CLOSED_SHORT, E.CANCELLED],
  ])('%s a %s es inválida', (desde, hacia) => {
    expect(() => validarTransicion(desde, hacia)).toThrow(/no puede pasar a/);
  });

  it('sólo el borrador se edita', () => {
    expect(() => validarEditable(E.DRAFT)).not.toThrow();
    expect(() => validarEditable(E.SENT)).toThrow(
      /Sólo se edita una orden en borrador/,
    );
  });
});

describe('estado según lo recibido', () => {
  it('nada recibido: enviada', () => {
    expect(estadoSegunRecibido([{ quantity: 10, receivedQuantity: 0 }])).toBe(
      E.SENT,
    );
  });
  it('todo recibido: recibida', () => {
    expect(
      estadoSegunRecibido([
        { quantity: 10, receivedQuantity: 10 },
        { quantity: 5, receivedQuantity: 5 },
      ]),
    ).toBe(E.RECEIVED);
  });
  it('un renglón incompleto: parcial', () => {
    expect(
      estadoSegunRecibido([
        { quantity: 10, receivedQuantity: 10 },
        { quantity: 5, receivedQuantity: 1 },
      ]),
    ).toBe(E.PARTIALLY_RECEIVED);
  });
  it('pendiente nunca es negativo', () => {
    expect(pendienteDe({ quantity: 5, receivedQuantity: 7 })).toBe(0);
  });
});

describe('total', () => {
  it('rechaza un total que no entra en numeric(12,2)', () => {
    expect(() => totalDe([{ quantity: 5000, unitCost: 2_000_000 }])).toThrow(
      /supera el máximo/,
    );
  });

  it('suma con decimales sin error de coma flotante', () => {
    expect(
      totalDe([
        { quantity: 3, unitCost: 0.1 },
        { quantity: 7, unitCost: 0.2 },
      ]),
    ).toBe(1.7);
  });
});

describe('costo promedio ponderado', () => {
  it('sin existencia previa es el costo nuevo', () => {
    expect(
      costoPromedioPonderado({
        existenciaPrevia: 0,
        costoPrevio: 500,
        cantidad: 10,
        costoNuevo: 800,
      }),
    ).toBe(800);
  });

  it('sin costo previo es el costo nuevo', () => {
    expect(
      costoPromedioPonderado({
        existenciaPrevia: 30,
        costoPrevio: null,
        cantidad: 10,
        costoNuevo: 800,
      }),
    ).toBe(800);
  });

  it('pondera por cantidad', () => {
    // (30 × 1000 + 10 × 1400) / 40 = 1100
    expect(
      costoPromedioPonderado({
        existenciaPrevia: 30,
        costoPrevio: 1000,
        cantidad: 10,
        costoNuevo: 1400,
      }),
    ).toBe(1100);
  });

  it('redondea a dos decimales', () => {
    // (1 × 100 + 2 × 100.01) / 3 = 100.00666…
    expect(
      costoPromedioPonderado({
        existenciaPrevia: 1,
        costoPrevio: 100,
        cantidad: 2,
        costoNuevo: 100.01,
      }),
    ).toBe(100.01);
  });
});

describe('costo promedio al anular una recepción', () => {
  const base = {
    costoActual: 150,
    costoPrevio: 100,
    existenciaPrevia: 10,
    cantidad: 10,
    costoRecibido: 200,
    hayOtrasCompras: true,
    hayCompraPosterior: false,
    promedioDeLasOtras: 100,
  };

  it('la única compra: el costo vuelve a null', () => {
    expect(
      costoPromedioAlAnular({
        ...base,
        hayOtrasCompras: false,
        costoPrevio: null,
        promedioDeLasOtras: null,
      }),
    ).toBeNull();
  });

  it.each([0, 1, 2, 5])(
    'sin compras posteriores vuelve EXACTO al previo aunque se hayan vendido %s',
    () => {
      // las ventas no cambian el promedio: el actual sigue siendo 150
      expect(costoPromedioAlAnular(base)).toBe(100);
    },
  );

  it('con una compra posterior resta lo que esta compra había movido', () => {
    // movió (200 - 100) x 10 / 20 = 50; hoy 160 -> 110
    expect(
      costoPromedioAlAnular({
        ...base,
        costoActual: 160,
        hayCompraPosterior: true,
      }),
    ).toBe(110);
  });

  it('nunca queda negativo', () => {
    expect(
      costoPromedioAlAnular({
        ...base,
        costoActual: 10,
        hayCompraPosterior: true,
      }),
    ).toBe(0);
  });

  it('sin costo previo usa el promedio de las otras compras', () => {
    expect(
      costoPromedioAlAnular({
        ...base,
        costoPrevio: null,
        promedioDeLasOtras: 130.5,
      }),
    ).toBe(130.5);
  });

  it('una recepción vieja sin snapshot no cambia el promedio', () => {
    expect(costoPromedioAlAnular({ ...base, existenciaPrevia: null })).toBe(
      150,
    );
  });
});

describe('renglones de una recepción', () => {
  it('rechaza vacía, repetidos y renglones sin nada', () => {
    expect(() => validarRenglonesDeRecepcion([])).toThrow(
      /al menos un renglón/,
    );
    expect(() =>
      validarRenglonesDeRecepcion([
        { gasCylinderId: 'a', quantityFull: 1, quantityEmptyOut: 0 },
        { gasCylinderId: 'a', quantityFull: 1, quantityEmptyOut: 0 },
      ]),
    ).toThrow(/dos veces/);
    expect(() =>
      validarRenglonesDeRecepcion([
        { gasCylinderId: 'a', quantityFull: 0, quantityEmptyOut: 0 },
      ]),
    ).toThrow(/llenas o entregar vacías/);
  });

  it('detecta lo que se pasa de lo pendiente', () => {
    const pedido = new Map([['a', { quantity: 10, receivedQuantity: 6 }]]);
    expect(
      excesosDeRecepcion(pedido, [{ gasCylinderId: 'a', quantityFull: 4 }]),
    ).toEqual([]);
    expect(
      excesosDeRecepcion(pedido, [{ gasCylinderId: 'a', quantityFull: 5 }]),
    ).toEqual([{ gasCylinderId: 'a', pendiente: 4, recibido: 5 }]);
  });
});
