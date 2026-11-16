import { EntityManager } from 'typeorm';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../stock.enums';

/** Un extremo de un movimiento: una ubicación y la condición de las garrafas. */
export interface ExtremoDeStock {
  locationId: string;
  condition: StockCondition;
}

export interface MovimientoDeStock {
  gasCylinderId: string;
  /** Entero mayor que cero. */
  quantity: number;
  /** `null`: las garrafas entran desde afuera (planta, cliente, hallazgo). */
  from: ExtremoDeStock | null;
  /** `null`: las garrafas salen (cliente, planta, merma). */
  to: ExtremoDeStock | null;
  reason: StockMovementReason;
  /** Sólo en un contraasiento: el movimiento que anula. */
  reverses?: string;
}

/**
 * Qué pasa con el stock vendible (`gas_cylinder.stock`, D4) cuando la
 * operación cambia las garrafas llenas que hay en depósitos y camiones:
 *  - `sigue-al-fisico`: el vendible suma o resta lo mismo (recepción, ajuste,
 *    merma, conteo).
 *  - `sin-cambio`: el vendible no se toca porque ya se descontó al reservar el
 *    pedido (entrega).
 */
export type EfectoSobreVendible = 'sigue-al-fisico' | 'sin-cambio';

export interface OperacionDeStock {
  distributorId: string;
  referenceType: StockReferenceType;
  referenceId: string | null;
  /** `null`: lo hizo el sistema (entrega, cron). */
  actorUserId: string | null;
  movimientos: MovimientoDeStock[];
  /** Por defecto `sigue-al-fisico`. */
  vendible?: EfectoSobreVendible;
  /** Agrupa los movimientos de la operación; si falta, el libro genera uno. */
  batchId?: string;
  occurredAt?: Date;
  notes?: string | null;
}

export interface ResultadoDeOperacion {
  batchId: string;
  movementIds: string[];
}

/**
 * ÚNICO punto de escritura del stock físico. Quien necesite mover garrafas
 * lo hace con una operación; nadie más toca `stock_balance` ni
 * `stock_movement`.
 */
export abstract class StockLedgerPort {
  /**
   * Corre dentro de la transacción de quien llama (`manager`): bloquea en el
   * orden global, valida que ningún saldo quede negativo, actualiza los saldos
   * materializados e inserta los movimientos.
   */
  abstract aplicar(
    manager: EntityManager,
    op: OperacionDeStock,
  ): Promise<ResultadoDeOperacion>;

  /**
   * Corrige un lote ya asentado con su contraasiento: movimientos inversos
   * (`reason = reversal`) que apuntan a los originales. El libro no se edita.
   * Falla con 409 si el lote ya fue contraasentado o si las garrafas ya no
   * están donde estaban (el saldo quedaría negativo).
   */
  abstract contraasentar(
    manager: EntityManager,
    args: {
      distributorId: string;
      batchId: string;
      actorUserId: string | null;
      notes?: string | null;
    },
  ): Promise<ResultadoDeOperacion>;
}
