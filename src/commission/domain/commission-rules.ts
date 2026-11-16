import Decimal from 'decimal.js';
import { CommissionBasis, LiquidationStatus } from './commission.enums';
import {
  ComisionConflictoError,
  ComisionInvalidaError,
} from './errors/commission.errors';
import { derivarTransiciones } from '../../common/domain/derivar-transiciones';

/** Lo que importa de una regla para elegirla y calcular con ella. */
export interface ReglaDeComision {
  ruleId: string;
  employeeId: string | null;
  gasCylinderId: string | null;
  basis: CommissionBasis;
  value: number;
  validFrom: string;
  validTo: string | null;
}

export interface RenglonDeComision {
  gasCylinderId: string;
  quantity: number;
  subtotal: number;
}

export interface LineaDeComision {
  ruleId: string;
  basis: CommissionBasis;
  value: number;
  gasCylinderId: string | null;
  quantity: number;
  subtotal: number;
  amount: number;
}

/** ¿La regla rige ese día (`YYYY-MM-DD`)? Ambos extremos inclusive. */
export function rigeEl(regla: ReglaDeComision, dia: string): boolean {
  return (
    regla.validFrom <= dia && (regla.validTo === null || dia <= regla.validTo)
  );
}

/**
 * La regla que gana para un chofer y un producto un día dado. Precedencia:
 * empleado y producto > empleado > producto > general. Las que apuntan a otro
 * empleado u otro producto no aplican.
 */
export function reglaGanadora(
  reglas: readonly ReglaDeComision[],
  employeeId: string,
  gasCylinderId: string,
  dia: string,
): ReglaDeComision | null {
  let mejor: ReglaDeComision | null = null;
  let puntaje = -1;
  for (const r of reglas) {
    if (!rigeEl(r, dia)) continue;
    if (r.employeeId !== null && r.employeeId !== employeeId) continue;
    if (r.gasCylinderId !== null && r.gasCylinderId !== gasCylinderId) continue;
    const p =
      (r.employeeId !== null ? 2 : 0) + (r.gasCylinderId !== null ? 1 : 0);
    if (p > puntaje) {
      mejor = r;
      puntaje = p;
    }
  }
  return mejor;
}

/**
 * Comisión de un pedido: cada renglón se paga con la regla que le toca. Por
 * unidad = valor × cantidad; porcentaje = valor % del subtotal del renglón,
 * redondeado a centavos; por pedido = el valor una sola vez por regla. La suma
 * es la de los importes ya redondeados.
 */
export function calcularComision(
  reglas: readonly ReglaDeComision[],
  employeeId: string,
  dia: string,
  renglones: readonly RenglonDeComision[],
): { total: Decimal; lineas: LineaDeComision[] } {
  const lineas: LineaDeComision[] = [];
  const porPedidoYaPagadas = new Set<string>();
  for (const renglon of renglones) {
    const regla = reglaGanadora(reglas, employeeId, renglon.gasCylinderId, dia);
    if (!regla) continue;
    let importe: Decimal;
    if (regla.basis === CommissionBasis.PER_UNIT) {
      importe = new Decimal(regla.value).times(renglon.quantity);
    } else if (regla.basis === CommissionBasis.PERCENT_OF_TOTAL) {
      importe = new Decimal(regla.value).times(renglon.subtotal).div(100);
    } else {
      if (porPedidoYaPagadas.has(regla.ruleId)) continue;
      porPedidoYaPagadas.add(regla.ruleId);
      importe = new Decimal(regla.value);
    }
    lineas.push({
      ruleId: regla.ruleId,
      basis: regla.basis,
      value: regla.value,
      gasCylinderId: regla.gasCylinderId,
      quantity: renglon.quantity,
      subtotal: renglon.subtotal,
      amount: importe.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber(),
    });
  }
  const total = lineas.reduce((s, l) => s.plus(l.amount), new Decimal(0));
  return { total, lineas };
}

/** Valida valor y vigencia de una regla (400). */
export function validarRegla(r: {
  basis: CommissionBasis;
  value: number;
  validFrom: string;
  validTo: string | null;
}): void {
  if (r.value < 0) {
    throw new ComisionInvalidaError(
      'El valor de la regla no puede ser negativo',
    );
  }
  if (r.basis === CommissionBasis.PERCENT_OF_TOTAL && r.value > 100) {
    throw new ComisionInvalidaError('El porcentaje no puede superar 100');
  }
  if (r.validTo !== null && r.validTo < r.validFrom) {
    throw new ComisionInvalidaError(
      'La vigencia termina antes de empezar: «Válido hasta» no puede ser anterior a «Válido desde»',
    );
  }
}

/** ¿Dos reglas del mismo alcance se pisan en el tiempo? (rangos cerrados, `null` = abierto). */
export function seSolapan(
  a: Pick<
    ReglaDeComision,
    'employeeId' | 'gasCylinderId' | 'validFrom' | 'validTo'
  >,
  b: Pick<
    ReglaDeComision,
    'employeeId' | 'gasCylinderId' | 'validFrom' | 'validTo'
  >,
): boolean {
  if (a.employeeId !== b.employeeId || a.gasCylinderId !== b.gasCylinderId) {
    return false;
  }
  const aTerminaAntes = a.validTo !== null && a.validTo < b.validFrom;
  const bTerminaAntes = b.validTo !== null && b.validTo < a.validFrom;
  return !aTerminaAntes && !bTerminaAntes;
}

export type AccionDeLiquidacion = 'approve' | 'pay' | 'unpay' | 'void';

const TEXTO: Record<LiquidationStatus, string> = {
  [LiquidationStatus.DRAFT]: 'en borrador',
  [LiquidationStatus.APPROVED]: 'aprobada',
  [LiquidationStatus.PAID]: 'pagada',
  [LiquidationStatus.VOIDED]: 'anulada',
};

const ESTADOS_PERMITIDOS: Record<AccionDeLiquidacion, LiquidationStatus[]> = {
  approve: [LiquidationStatus.DRAFT],
  pay: [LiquidationStatus.APPROVED],
  unpay: [LiquidationStatus.PAID],
  void: [LiquidationStatus.DRAFT, LiquidationStatus.APPROVED],
};

/** Estado al que lleva cada acción. */
const HACIA: Record<AccionDeLiquidacion, LiquidationStatus> = {
  approve: LiquidationStatus.APPROVED,
  pay: LiquidationStatus.PAID,
  unpay: LiquidationStatus.APPROVED,
  void: LiquidationStatus.VOIDED,
};

/**
 * Transiciones válidas del estado de la liquidación, derivadas de las mismas
 * tablas que aplica `exigirEstadoDeLiquidacion` (la base las repite en el trigger
 * `TRG_driver_liquidation_transicion_de_estado`; un spec compara las dos): borrador
 * → aprobada → pagada, pagada → aprobada (se anula el pago) y anulada desde
 * borrador o aprobada.
 */
export const TRANSICIONES_DE_LIQUIDACION: Readonly<
  Record<LiquidationStatus, readonly LiquidationStatus[]>
> = derivarTransiciones(Object.values(LiquidationStatus), (desde) =>
  (Object.keys(ESTADOS_PERMITIDOS) as AccionDeLiquidacion[])
    .filter((accion) => ESTADOS_PERMITIDOS[accion].includes(desde))
    .map((accion) => HACIA[accion]),
);

const VERBO: Record<AccionDeLiquidacion, string> = {
  approve: 'se aprueba',
  pay: 'se paga',
  unpay: 'se anula el pago de',
  void: 'se anula',
};

/** 409 si la acción no corresponde al estado de la liquidación. */
export function exigirEstadoDeLiquidacion(
  estado: LiquidationStatus,
  accion: AccionDeLiquidacion,
): void {
  if (!ESTADOS_PERMITIDOS[accion].includes(estado)) {
    throw new ComisionConflictoError(
      `La liquidación está ${TEXTO[estado]}: sólo ${VERBO[accion]} una liquidación ${ESTADOS_PERMITIDOS[accion].map((e) => TEXTO[e]).join(' o ')}${
        accion === 'void' && estado === LiquidationStatus.PAID
          ? '. Una pagada ya sacó dinero de una caja: anulá primero el pago (PATCH /driver-liquidations/:id/unpay) y después la liquidación'
          : ''
      }`,
    );
  }
}
