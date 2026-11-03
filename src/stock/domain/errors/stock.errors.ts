import {
  BadRequestDomainError,
  NotFoundDomainError,
} from '../../../common/errors/domain.error';
import { StockCondition } from '../stock.enums';

/** Un saldo que la operación dejaría por debajo de cero. */
export interface FaltanteDeStock {
  locationId: string;
  locationLabel: string;
  gasCylinderId: string;
  gasCylinderType: string;
  condition: StockCondition;
  available: number;
  requested: number;
}

const CONDICION_EN_TEXTO: Record<StockCondition, string> = {
  [StockCondition.FULL]: 'llenas',
  [StockCondition.EMPTY]: 'vacías',
  [StockCondition.DEFECTIVE]: 'defectuosas',
};

/**
 * Ninguna ubicación puede quedar con saldo negativo. Se mapea a 400 y el
 * mensaje dice qué falta y dónde.
 */
export class StockInsuficienteError extends BadRequestDomainError {
  constructor(readonly faltantes: FaltanteDeStock[]) {
    super(
      'Stock insuficiente: ' +
        faltantes
          .map(
            (f) =>
              `${f.gasCylinderType} ${CONDICION_EN_TEXTO[f.condition]} en ${f.locationLabel} (hay ${f.available}, se necesitan ${f.requested})`,
          )
          .join('; '),
    );
  }
}

/** La operación es inválida por sí misma (cantidades, origen y destino). */
export class OperacionDeStockInvalidaError extends BadRequestDomainError {
  constructor(motivo: string) {
    super(motivo);
  }
}

/** La ubicación o la garrafa no existe o es de otra distribuidora. */
export class UbicacionNoEncontradaError extends NotFoundDomainError {
  constructor(
    readonly id: string,
    rol?: 'origen' | 'destino',
  ) {
    super(
      rol
        ? `Ubicación de ${rol} no encontrada`
        : 'Ubicación de stock no encontrada',
      `id=${id}`,
    );
  }
}

/** El lote de movimientos que se quiere contraasentar no existe en la distribuidora. */
export class LoteNoEncontradoError extends NotFoundDomainError {
  constructor(readonly batchId: string) {
    super('Lote de movimientos no encontrado', `batchId=${batchId}`);
  }
}

/** La garrafa de un movimiento no existe o es de otra distribuidora. */
export class GarrafaNoEncontradaEnStockError extends NotFoundDomainError {
  constructor(
    readonly gasCylinderId: string,
    renglon?: number,
  ) {
    super(
      renglon
        ? `Garrafa del renglón ${renglon} no encontrada`
        : 'Garrafa no encontrada',
      `gasCylinderId=${gasCylinderId}`,
    );
  }
}
