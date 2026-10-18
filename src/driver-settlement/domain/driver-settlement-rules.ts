import Decimal from 'decimal.js';
import {
  DifferenceResolution,
  DriverSettlementStatus,
} from './driver-settlement.enums';
import {
  RendicionEnOtroEstadoError,
  RendicionInvalidaError,
} from './errors/driver-settlement.errors';

export type AccionDeRendicion = 'submit' | 'approve' | 'reopen';

const DESDE: Record<AccionDeRendicion, DriverSettlementStatus> = {
  submit: DriverSettlementStatus.OPEN,
  approve: DriverSettlementStatus.SUBMITTED,
  reopen: DriverSettlementStatus.SUBMITTED,
};

const TEXTO: Record<DriverSettlementStatus, string> = {
  [DriverSettlementStatus.OPEN]: 'abierta',
  [DriverSettlementStatus.SUBMITTED]: 'presentada',
  [DriverSettlementStatus.APPROVED]: 'aprobada',
};

const VERBO: Record<AccionDeRendicion, string> = {
  submit: 'se presenta',
  approve: 'se aprueba',
  reopen: 'se reabre',
};

/**
 * Máquina de estados de la rendición: abierta → presentada → aprobada, y
 * presentada → abierta al reabrirla. Una aprobada ya movió dinero a una caja y
 * no se reabre: se corrige anulando el movimiento y ajustando la deducción.
 * 409 si la acción no corresponde al estado.
 */
export function exigirEstado(
  estado: DriverSettlementStatus,
  accion: AccionDeRendicion,
): void {
  if (estado !== DESDE[accion]) {
    throw new RendicionEnOtroEstadoError(
      `La rendición está ${TEXTO[estado]}: sólo ${VERBO[accion]} una ${TEXTO[DESDE[accion]]}`,
    );
  }
}

/** Diferencia: declarado + gastos − esperado (negativa: faltante; positiva: sobrante). */
export function diferenciaDeRendicion(
  declarado: Decimal.Value,
  gastos: Decimal.Value,
  esperado: Decimal.Value,
): Decimal {
  return new Decimal(declarado).plus(gastos).minus(esperado);
}

/**
 * Cómo se resuelve la diferencia al aprobar. Sin diferencia no hay nada que
 * resolver (`none`). Con diferencia hay que decidirlo (400) y sólo un faltante
 * puede quedar a cargo del chofer.
 */
export function resolucionDeDiferencia(
  diferencia: Decimal.Value,
  pedida: DifferenceResolution | undefined,
): DifferenceResolution {
  const dif = new Decimal(diferencia);
  if (dif.isZero()) return DifferenceResolution.NONE;
  if (!pedida || pedida === DifferenceResolution.NONE) {
    throw new RendicionInvalidaError(
      'Hay una diferencia: indicá cómo se resuelve (differenceResolution: absorbed o charged_to_driver)',
    );
  }
  if (pedida === DifferenceResolution.CHARGED_TO_DRIVER && dif.gt(0)) {
    throw new RendicionInvalidaError(
      'Un sobrante no se le descuenta al chofer: resolvelo como absorbed',
    );
  }
  return pedida;
}
