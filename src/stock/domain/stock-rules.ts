import { ExtremoDeStock, MovimientoDeStock } from './ports/stock-ledger.port';
import { OperacionDeStockInvalidaError } from './errors/stock.errors';
import {
  StockAdjustmentReason,
  StockCondition,
  StockMovementReason,
} from './stock.enums';
import { valorLegible } from '../../common/validation/etiquetas';

/** Clave de un saldo: ubicación, tipo de garrafa y condición. */
export function claveDeSaldo(
  locationId: string,
  gasCylinderId: string,
  condition: StockCondition,
): string {
  return `${locationId}|${gasCylinderId}|${condition}`;
}

export interface DeltaDeSaldo {
  locationId: string;
  gasCylinderId: string;
  condition: StockCondition;
  delta: number;
}

/** Orden global de locks de saldos: ubicación, tipo y condición. */
export function compararSaldos(
  a: { locationId: string; gasCylinderId: string; condition: StockCondition },
  b: { locationId: string; gasCylinderId: string; condition: StockCondition },
): number {
  return (
    a.locationId.localeCompare(b.locationId) ||
    a.gasCylinderId.localeCompare(b.gasCylinderId) ||
    a.condition.localeCompare(b.condition)
  );
}

function mismoExtremo(a: ExtremoDeStock | null, b: ExtremoDeStock | null) {
  return (
    a !== null &&
    b !== null &&
    a.locationId === b.locationId &&
    a.condition === b.condition
  );
}

/** Rechaza un movimiento mal formado antes de tocar la base. */
export function validarMovimiento(m: MovimientoDeStock): void {
  if (!Number.isInteger(m.quantity) || m.quantity <= 0) {
    throw new OperacionDeStockInvalidaError(
      'La cantidad de un movimiento tiene que ser un entero mayor que cero',
    );
  }
  if (m.from === null && m.to === null) {
    throw new OperacionDeStockInvalidaError(
      'Un movimiento necesita origen o destino',
    );
  }
  if (mismoExtremo(m.from, m.to)) {
    throw new OperacionDeStockInvalidaError(
      'El origen y el destino del movimiento son el mismo',
    );
  }
}

/**
 * Suma los movimientos por saldo y descarta los que se compensan. Quedan
 * ordenados en el orden global de locks.
 */
export function netearSaldos(movimientos: MovimientoDeStock[]): DeltaDeSaldo[] {
  const acumulado = new Map<string, DeltaDeSaldo>();
  const sumar = (
    extremo: ExtremoDeStock | null,
    gasCylinderId: string,
    delta: number,
  ) => {
    if (!extremo) return;
    const clave = claveDeSaldo(
      extremo.locationId,
      gasCylinderId,
      extremo.condition,
    );
    const previo = acumulado.get(clave);
    acumulado.set(clave, {
      locationId: extremo.locationId,
      gasCylinderId,
      condition: extremo.condition,
      delta: (previo?.delta ?? 0) + delta,
    });
  };
  for (const m of movimientos) {
    sumar(m.from, m.gasCylinderId, -m.quantity);
    sumar(m.to, m.gasCylinderId, m.quantity);
  }
  return [...acumulado.values()]
    .filter((s) => s.delta !== 0)
    .sort(compararSaldos);
}

/**
 * Cuánto cambia el físico lleno (depósitos y camiones) de cada garrafa. Es el
 * cambio del vendible cuando la operación lo sigue (D4): las llenas que se
 * mueven entre ubicaciones se compensan.
 */
export function cambioDeLlenasPorGarrafa(
  movimientos: MovimientoDeStock[],
): Map<string, number> {
  const cambio = new Map<string, number>();
  const sumar = (id: string, delta: number) =>
    cambio.set(id, (cambio.get(id) ?? 0) + delta);
  for (const m of movimientos) {
    if (m.to?.condition === StockCondition.FULL)
      sumar(m.gasCylinderId, m.quantity);
    if (m.from?.condition === StockCondition.FULL) {
      sumar(m.gasCylinderId, -m.quantity);
    }
  }
  for (const [id, delta] of cambio) if (delta === 0) cambio.delete(id);
  return cambio;
}

export interface ItemDeAjuste {
  gasCylinderId: string;
  condition: StockCondition;
  quantityDelta: number;
}

/** Los motivos de un ajuste que el administrador puede elegir. */
export const MOTIVOS_DE_AJUSTE: readonly StockAdjustmentReason[] = [
  StockAdjustmentReason.COUNT_CORRECTION,
  StockAdjustmentReason.SHRINKAGE,
  StockAdjustmentReason.LEAK,
  StockAdjustmentReason.DAMAGED,
  StockAdjustmentReason.LOST,
  StockAdjustmentReason.FOUND,
];

const MOTIVOS_DE_BAJA: readonly StockAdjustmentReason[] = [
  StockAdjustmentReason.SHRINKAGE,
  StockAdjustmentReason.LEAK,
  StockAdjustmentReason.DAMAGED,
  StockAdjustmentReason.LOST,
];

/** Las reglas de signo y condición de cada motivo. */
export function validarItemsDeAjuste(
  reason: StockAdjustmentReason,
  items: ItemDeAjuste[],
): void {
  if (items.length === 0) {
    throw new OperacionDeStockInvalidaError(
      'El ajuste necesita al menos un ítem',
    );
  }
  const vistos = new Set<string>();
  for (const item of items) {
    if (!Number.isInteger(item.quantityDelta) || item.quantityDelta === 0) {
      throw new OperacionDeStockInvalidaError(
        'La variación de cada ítem tiene que ser un entero distinto de cero',
      );
    }
    const clave = `${item.gasCylinderId}|${item.condition}`;
    if (vistos.has(clave)) {
      throw new OperacionDeStockInvalidaError(
        'Hay dos ítems para la misma garrafa y condición',
      );
    }
    vistos.add(clave);
    if (MOTIVOS_DE_BAJA.includes(reason) && item.quantityDelta > 0) {
      throw new OperacionDeStockInvalidaError(
        `Con el motivo «${valorLegible(reason)}» la variación tiene que ser negativa`,
      );
    }
    if (reason === StockAdjustmentReason.FOUND && item.quantityDelta < 0) {
      throw new OperacionDeStockInvalidaError(
        'Con el motivo found la variación tiene que ser positiva',
      );
    }
    if (
      reason === StockAdjustmentReason.DAMAGED &&
      item.condition !== StockCondition.FULL
    ) {
      throw new OperacionDeStockInvalidaError(
        'Una rotura pasa garrafas llenas a defectuosas: la condición es full',
      );
    }
  }
}

/**
 * Los movimientos que produce un ajuste en una ubicación:
 *  - rotura: la llena pasa a defectuosa en la misma ubicación;
 *  - baja (merma, fuga, pérdida o variación negativa): sale de la ubicación;
 *  - alta (hallazgo o variación positiva): entra a la ubicación.
 */
export function movimientosDeAjuste(
  reason: StockAdjustmentReason,
  locationId: string,
  items: ItemDeAjuste[],
): MovimientoDeStock[] {
  return items.map((item) => {
    const cantidad = Math.abs(item.quantityDelta);
    const aqui: ExtremoDeStock = { locationId, condition: item.condition };
    if (reason === StockAdjustmentReason.DAMAGED) {
      return {
        gasCylinderId: item.gasCylinderId,
        quantity: cantidad,
        from: aqui,
        to: { locationId, condition: StockCondition.DEFECTIVE },
        reason: StockMovementReason.CONDITION_CHANGE,
      };
    }
    const esConteo = reason === StockAdjustmentReason.INITIAL_COUNT;
    if (item.quantityDelta < 0) {
      return {
        gasCylinderId: item.gasCylinderId,
        quantity: cantidad,
        from: aqui,
        to: null,
        reason: esConteo
          ? StockMovementReason.INITIAL_COUNT
          : MOTIVOS_DE_BAJA.includes(reason)
            ? StockMovementReason.SHRINKAGE
            : StockMovementReason.ADJUSTMENT,
      };
    }
    return {
      gasCylinderId: item.gasCylinderId,
      quantity: cantidad,
      from: null,
      to: aqui,
      reason: esConteo
        ? StockMovementReason.INITIAL_COUNT
        : StockMovementReason.ADJUSTMENT,
    };
  });
}

export interface DiferenciaDeVendible {
  gasCylinderId: string;
  /** `gas_cylinder.stock`. */
  sellable: number;
  /** Σ llenas en depósitos y camiones. */
  physicalFull: number;
  /** Σ cantidades de pedidos abiertos. */
  reserved: number;
  /** `max(0, physicalFull - reserved)`. */
  expected: number;
  /** Reservas que el físico no cubre: `max(0, reserved - physicalFull)`. */
  overReserved: number;
  /** `sellable - expected`; distinto de cero es una discrepancia. */
  difference: number;
}

/**
 * Invariante D4: vendible = max(0, Σ llenas físicas − Σ pedidos abiertos). Si
 * las reservas pasan al físico (una merma o un faltante con pedidos abiertos) el
 * vendible queda en cero y el exceso se informa en `overReserved`.
 */
export function conciliarVendible(
  gasCylinderId: string,
  sellable: number,
  physicalFull: number,
  reserved: number,
): DiferenciaDeVendible {
  const expected = Math.max(0, physicalFull - reserved);
  return {
    gasCylinderId,
    sellable,
    physicalFull,
    reserved,
    expected,
    overReserved: Math.max(0, reserved - physicalFull),
    difference: sellable - expected,
  };
}

/**
 * Pasa un conteo absoluto a variaciones sobre el saldo actual. Descarta lo
 * que ya coincide.
 */
export function variacionesDeConteo(
  actuales: ReadonlyMap<string, number>,
  contados: Array<{
    gasCylinderId: string;
    condition: StockCondition;
    quantity: number;
  }>,
): ItemDeAjuste[] {
  const items: ItemDeAjuste[] = [];
  for (const c of contados) {
    const actual = actuales.get(`${c.gasCylinderId}|${c.condition}`) ?? 0;
    const delta = c.quantity - actual;
    if (delta !== 0) {
      items.push({
        gasCylinderId: c.gasCylinderId,
        condition: c.condition,
        quantityDelta: delta,
      });
    }
  }
  return items;
}
