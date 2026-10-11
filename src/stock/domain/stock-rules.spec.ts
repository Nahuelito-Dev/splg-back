import {
  cambioDeLlenasPorGarrafa,
  conciliarVendible,
  movimientosDeAjuste,
  netearSaldos,
  validarItemsDeAjuste,
  validarMovimiento,
  variacionesDeConteo,
} from './stock-rules';
import { MovimientoDeStock } from './ports/stock-ledger.port';
import {
  StockAdjustmentReason as Motivo,
  StockCondition as Cond,
  StockMovementReason as Razon,
} from './stock.enums';
import { OperacionDeStockInvalidaError } from './errors/stock.errors';

const L1 = '00000000-0000-4000-8000-000000000001';
const L2 = '00000000-0000-4000-8000-000000000002';
const G1 = '10000000-0000-4000-8000-000000000001';
const G2 = '10000000-0000-4000-8000-000000000002';

const mov = (over: Partial<MovimientoDeStock> = {}): MovimientoDeStock => ({
  gasCylinderId: G1,
  quantity: 5,
  from: { locationId: L1, condition: Cond.FULL },
  to: { locationId: L2, condition: Cond.FULL },
  reason: Razon.TRANSFER,
  ...over,
});

describe('validarMovimiento', () => {
  it.each([0, -1, 1.5, NaN])('rechaza la cantidad %p', (quantity) => {
    expect(() => validarMovimiento(mov({ quantity }))).toThrow(
      OperacionDeStockInvalidaError,
    );
  });

  it('exige origen o destino', () => {
    expect(() => validarMovimiento(mov({ from: null, to: null }))).toThrow(
      /origen o destino/,
    );
  });

  it('rechaza mover algo al mismo lugar y condición', () => {
    expect(() =>
      validarMovimiento(
        mov({
          from: { locationId: L1, condition: Cond.FULL },
          to: { locationId: L1, condition: Cond.FULL },
        }),
      ),
    ).toThrow(/el mismo/);
  });

  it('cambiar de condición en la misma ubicación sí es válido', () => {
    expect(() =>
      validarMovimiento(
        mov({
          from: { locationId: L1, condition: Cond.FULL },
          to: { locationId: L1, condition: Cond.DEFECTIVE },
        }),
      ),
    ).not.toThrow();
  });
});

describe('netearSaldos', () => {
  it('una transferencia resta del origen y suma al destino', () => {
    expect(netearSaldos([mov()])).toEqual([
      { locationId: L1, gasCylinderId: G1, condition: Cond.FULL, delta: -5 },
      { locationId: L2, gasCylinderId: G1, condition: Cond.FULL, delta: 5 },
    ]);
  });

  it('un movimiento que entra desde afuera sólo suma', () => {
    expect(netearSaldos([mov({ from: null })])).toEqual([
      { locationId: L2, gasCylinderId: G1, condition: Cond.FULL, delta: 5 },
    ]);
  });

  it('descarta lo que se compensa y suma los repetidos', () => {
    const saldos = netearSaldos([
      mov(),
      mov({
        from: { locationId: L2, condition: Cond.FULL },
        to: { locationId: L1, condition: Cond.FULL },
      }),
      mov({
        from: null,
        to: { locationId: L1, condition: Cond.EMPTY },
        quantity: 2,
      }),
      mov({
        from: null,
        to: { locationId: L1, condition: Cond.EMPTY },
        quantity: 3,
      }),
    ]);
    expect(saldos).toEqual([
      { locationId: L1, gasCylinderId: G1, condition: Cond.EMPTY, delta: 5 },
    ]);
  });

  it('los devuelve en el orden de locks: ubicación, tipo y condición', () => {
    const saldos = netearSaldos([
      mov({
        gasCylinderId: G2,
        from: null,
        to: { locationId: L2, condition: Cond.FULL },
      }),
      mov({
        gasCylinderId: G1,
        from: null,
        to: { locationId: L2, condition: Cond.EMPTY },
      }),
      mov({
        gasCylinderId: G1,
        from: null,
        to: { locationId: L1, condition: Cond.FULL },
      }),
      mov({
        gasCylinderId: G1,
        from: null,
        to: { locationId: L2, condition: Cond.FULL },
      }),
    ]);
    expect(
      saldos.map((s) => [s.locationId, s.gasCylinderId, s.condition]),
    ).toEqual([
      [L1, G1, Cond.FULL],
      [L2, G1, Cond.EMPTY],
      [L2, G1, Cond.FULL],
      [L2, G2, Cond.FULL],
    ]);
  });
});

describe('cambioDeLlenasPorGarrafa (efecto en el vendible, D4)', () => {
  it('una transferencia entre ubicaciones no cambia el vendible', () => {
    expect(cambioDeLlenasPorGarrafa([mov()]).size).toBe(0);
  });

  it('entrar llenas desde afuera suma; sacarlas resta', () => {
    expect(cambioDeLlenasPorGarrafa([mov({ from: null })]).get(G1)).toBe(5);
    expect(cambioDeLlenasPorGarrafa([mov({ to: null })]).get(G1)).toBe(-5);
  });

  it('las vacías y las defectuosas no tocan el vendible', () => {
    expect(
      cambioDeLlenasPorGarrafa([
        mov({ from: null, to: { locationId: L1, condition: Cond.EMPTY } }),
        mov({ from: { locationId: L1, condition: Cond.DEFECTIVE }, to: null }),
      ]).size,
    ).toBe(0);
  });

  it('una rotura (llena a defectuosa) resta del vendible', () => {
    expect(
      cambioDeLlenasPorGarrafa([
        mov({
          from: { locationId: L1, condition: Cond.FULL },
          to: { locationId: L1, condition: Cond.DEFECTIVE },
        }),
      ]).get(G1),
    ).toBe(-5);
  });
});

describe('validarItemsDeAjuste', () => {
  const item = (
    quantityDelta: number,
    condition = Cond.FULL,
    gasCylinderId = G1,
  ) => ({
    gasCylinderId,
    condition,
    quantityDelta,
  });

  it('necesita al menos un ítem y rechaza variaciones nulas', () => {
    expect(() => validarItemsDeAjuste(Motivo.COUNT_CORRECTION, [])).toThrow(
      /al menos un ítem/,
    );
    expect(() =>
      validarItemsDeAjuste(Motivo.COUNT_CORRECTION, [item(0)]),
    ).toThrow(/distinto de cero/);
  });

  it.each([Motivo.SHRINKAGE, Motivo.LEAK, Motivo.DAMAGED, Motivo.LOST])(
    '%s sólo admite variaciones negativas',
    (motivo) => {
      expect(() => validarItemsDeAjuste(motivo, [item(2)])).toThrow(/negativa/);
      expect(() => validarItemsDeAjuste(motivo, [item(-2)])).not.toThrow();
    },
  );

  it('encontrado sólo admite variaciones positivas', () => {
    expect(() => validarItemsDeAjuste(Motivo.FOUND, [item(-1)])).toThrow(
      /positiva/,
    );
    expect(() => validarItemsDeAjuste(Motivo.FOUND, [item(1)])).not.toThrow();
  });

  it('la corrección de conteo admite los dos signos', () => {
    expect(() =>
      validarItemsDeAjuste(Motivo.COUNT_CORRECTION, [
        item(3),
        item(-3, Cond.EMPTY),
      ]),
    ).not.toThrow();
  });

  it('la rotura sólo parte de llenas', () => {
    expect(() =>
      validarItemsDeAjuste(Motivo.DAMAGED, [item(-1, Cond.EMPTY)]),
    ).toThrow(/full/);
  });

  it('rechaza dos ítems de la misma garrafa y condición', () => {
    expect(() =>
      validarItemsDeAjuste(Motivo.COUNT_CORRECTION, [item(1), item(2)]),
    ).toThrow(/dos ítems/);
  });
});

describe('movimientosDeAjuste', () => {
  const item = (quantityDelta: number, condition = Cond.FULL) => ({
    gasCylinderId: G1,
    condition,
    quantityDelta,
  });

  it('una merma saca de la ubicación (shrinkage)', () => {
    expect(movimientosDeAjuste(Motivo.SHRINKAGE, L1, [item(-2)])).toEqual([
      {
        gasCylinderId: G1,
        quantity: 2,
        from: { locationId: L1, condition: Cond.FULL },
        to: null,
        reason: Razon.SHRINKAGE,
      },
    ]);
  });

  it('una rotura pasa llenas a defectuosas en el mismo lugar', () => {
    expect(movimientosDeAjuste(Motivo.DAMAGED, L1, [item(-2)])).toEqual([
      {
        gasCylinderId: G1,
        quantity: 2,
        from: { locationId: L1, condition: Cond.FULL },
        to: { locationId: L1, condition: Cond.DEFECTIVE },
        reason: Razon.CONDITION_CHANGE,
      },
    ]);
  });

  it('un hallazgo o una corrección positiva entra como adjustment', () => {
    expect(
      movimientosDeAjuste(Motivo.FOUND, L1, [item(3, Cond.EMPTY)]),
    ).toEqual([
      {
        gasCylinderId: G1,
        quantity: 3,
        from: null,
        to: { locationId: L1, condition: Cond.EMPTY },
        reason: Razon.ADJUSTMENT,
      },
    ]);
  });

  it('una corrección negativa sale como adjustment, no como merma', () => {
    expect(
      movimientosDeAjuste(Motivo.COUNT_CORRECTION, L1, [item(-3)])[0].reason,
    ).toBe(Razon.ADJUSTMENT);
  });

  it('el conteo inicial usa initial_count en los dos sentidos', () => {
    const [baja, alta] = movimientosDeAjuste(Motivo.INITIAL_COUNT, L1, [
      item(-3),
      item(4, Cond.EMPTY),
    ]);
    expect(baja.reason).toBe(Razon.INITIAL_COUNT);
    expect(alta.reason).toBe(Razon.INITIAL_COUNT);
  });
});

describe('conciliarVendible (invariante D4)', () => {
  it('cierra cuando vendible = llenas − reservadas', () => {
    expect(conciliarVendible(G1, 70, 100, 30)).toMatchObject({
      expected: 70,
      difference: 0,
    });
  });

  it('informa la diferencia con su signo', () => {
    expect(conciliarVendible(G1, 75, 100, 30).difference).toBe(5);
    expect(conciliarVendible(G1, 60, 100, 30).difference).toBe(-10);
  });
});

describe('variacionesDeConteo', () => {
  it('pasa lo contado a variaciones contra el saldo actual y omite lo que coincide', () => {
    const actuales = new Map([
      [`${G1}|${Cond.FULL}`, 10],
      [`${G1}|${Cond.EMPTY}`, 4],
    ]);
    expect(
      variacionesDeConteo(actuales, [
        { gasCylinderId: G1, condition: Cond.FULL, quantity: 12 },
        { gasCylinderId: G1, condition: Cond.EMPTY, quantity: 4 },
        { gasCylinderId: G1, condition: Cond.DEFECTIVE, quantity: 0 },
        { gasCylinderId: G2, condition: Cond.FULL, quantity: 7 },
      ]),
    ).toEqual([
      { gasCylinderId: G1, condition: Cond.FULL, quantityDelta: 2 },
      { gasCylinderId: G2, condition: Cond.FULL, quantityDelta: 7 },
    ]);
  });
});
