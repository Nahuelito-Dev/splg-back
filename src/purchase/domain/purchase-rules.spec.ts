import { PurchaseOrderStatus as E } from './purchase.enums';
import {
  costoPromedioPonderado,
  recalcularCostoPromedio,
  type CompraDeLaGarrafa,
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

describe('costo promedio recalculado al anular recepciones', () => {
  // 25 llenas sin costo ya en el depósito; después tres compras de 10:
  // R1 a $100 (existencia previa 25), R2 a $300 (35) y R3 a $100 (45).
  const compra = (
    numero: number,
    costoUnitario: number,
    existenciaPrevia: number,
    costoPrevio: number | null,
    extra: Partial<CompraDeLaGarrafa> = {},
  ): CompraDeLaGarrafa => ({
    numero,
    cantidad: 10,
    costoUnitario,
    costoPrevio,
    existenciaPrevia,
    vigente: true,
    altaEn: numero * 1000,
    anuladaEn: null,
    ...extra,
  });
  const R1 = (e: Partial<CompraDeLaGarrafa> = {}) =>
    compra(1, 100, 25, null, e);
  const R2 = (e: Partial<CompraDeLaGarrafa> = {}) => compra(2, 300, 35, 100, e);
  const R3 = (e: Partial<CompraDeLaGarrafa> = {}) =>
    compra(3, 100, 45, 144.44, e);
  const ahora = 10_000;
  const anulada = (en = ahora) => ({ vigente: false, anuladaEn: en });

  it('sin anular nada repite el promedio que dejó cada compra', () => {
    expect(recalcularCostoPromedio([R1(), R2(), R3()])).toBe(136.36);
  });

  it('anular la del medio deja el promedio de las que quedan, no uno menor que todas', () => {
    expect(recalcularCostoPromedio([R1(), R2(anulada()), R3()])).toBe(100);
  });

  it('anular la última vuelve a lo que había', () => {
    expect(recalcularCostoPromedio([R1(), R2(), R3(anulada())])).toBe(144.44);
  });

  it('anular la primera descuenta sus llenas de la existencia de las siguientes', () => {
    // R2 queda sobre 25 sin costo -> 300; R3 sobre 35: (35x300 + 10x100)/45
    expect(recalcularCostoPromedio([R1(anulada()), R2(), R3()])).toBe(255.56);
  });

  it('varias anulaciones seguidas dan lo mismo en cualquier orden', () => {
    // R2 se anuló en t=5000 (después de crearse R3, t=3000) y R3 recién ahora.
    const primeroR2 = recalcularCostoPromedio([
      R1(),
      R2(anulada(5000)),
      R3(anulada()),
    ]);
    // R3 se anuló primero y R2 ahora.
    const primeroR3 = recalcularCostoPromedio([
      R1(),
      R2(anulada()),
      R3(anulada(5000)),
    ]);
    expect(primeroR2).toBe(100);
    expect(primeroR3).toBe(100);
  });

  it('una anulación anterior a la compra siguiente ya no está en su existencia guardada', () => {
    // R2 se anuló (t=1500) antes de que existiera R3 (t=3000): el 45 de R3 ya no la cuenta.
    const r3 = compra(3, 100, 35, 100);
    expect(recalcularCostoPromedio([R1(), R2(anulada(1500)), r3])).toBe(100);
  });

  it('sin ninguna recepción vigente vuelve al promedio de partida', () => {
    expect(
      recalcularCostoPromedio([R1(anulada()), R2(anulada(5000))]),
    ).toBeNull();
    expect(recalcularCostoPromedio([])).toBeNull();
  });

  it('el promedio no depende de las ventas: la existencia guardada ya las trae', () => {
    // se vendieron 20 antes de R3: existencia previa 25 en lugar de 45
    const r3 = compra(3, 100, 25, 144.44);
    expect(recalcularCostoPromedio([R1(), R2(), r3])).toBe(
      costoPromedioPonderado({
        existenciaPrevia: 25,
        costoPrevio: 144.44,
        cantidad: 10,
        costoNuevo: 100,
      }),
    );
  });

  it('una recepción que lee su existencia después de una anulación no la resta de nuevo, aunque su transacción haya empezado antes', () => {
    // R1 se anula en t=5. R3 empezó su transacción en t=4 pero leyó la existencia
    // (10, ya sin R1) en t=6: el momento que cuenta es el de la lectura.
    const r3 = compra(3, 100, 10, 300, { altaEn: 6 });
    expect(
      recalcularCostoPromedio([
        R1(anulada(5)),
        R2({ costoPrevio: null, existenciaPrevia: 0 }),
        r3,
      ]),
    ).toBe(200);
  });

  it('si la lectura fue antes de la anulación, esa existencia sí incluía a la anulada', () => {
    const r3 = compra(3, 100, 20, 300, { altaEn: 4 });
    expect(
      recalcularCostoPromedio([
        R1(anulada(5)),
        R2({ costoPrevio: null, existenciaPrevia: 0 }),
        r3,
      ]),
    ).toBe(200);
  });

  it('una recepción vieja sin existencia guardada no se puede reconstruir', () => {
    expect(
      recalcularCostoPromedio([R1({ existenciaPrevia: null }), R2(anulada())]),
    ).toBe('no-reconstruible');
    expect(
      recalcularCostoPromedio([
        R1(),
        R2({ existenciaPrevia: null }),
        R3(anulada()),
      ]),
    ).toBe('no-reconstruible');
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
