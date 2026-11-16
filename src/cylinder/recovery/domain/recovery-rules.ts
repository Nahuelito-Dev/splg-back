import Decimal from 'decimal.js';
import {
  ESCALON_AGOTADO,
  RecoveryCaseStatus,
} from '../../entities/cylinder-recovery-case.entity';
import { RecoveryNoticeKind } from '../../entities/cylinder-recovery-notice.entity';
import { ValoresDeProceso } from '../../../distributor/process-config';
import { OrderRecoveryRef } from '../../../order/lookup/order-lookup.service';
import { OrderStatus } from '../../../order/entities/order.entity';

const MS_POR_DIA = 24 * 60 * 60 * 1000;
const MS_POR_HORA = 60 * 60 * 1000;

/** Los parámetros de la recuperación de envases (CU-108), ya tipados. */
export interface ParametrosDeRecupero {
  /** Días desde la entrega a partir de los cuales el envase se considera retenido. */
  toleranceDays: number;
  /** Cuánto dura cada escalón antes de pasar al siguiente. */
  escalationStepDays: number;
  /** Depósito desde el cual (estrictamente mayor) el caso escala al administrador. */
  escalationAmountThreshold: number;
  /** Vigencia de la oferta de retiro en la próxima entrega. */
  pickupOfferTtlHours: number;
  /** Ventana, en días, en que una entrega programada sirve para ofrecer el retiro. */
  pickupWindowDays: number;
  /** Hora (Argentina) en que corre el proceso. */
  runHour: number;
  /** El proceso está encendido para la distribuidora (apagado por omisión). */
  enabled: boolean;
}

export function parametrosDeRecupero(
  v: ValoresDeProceso,
): ParametrosDeRecupero {
  return {
    toleranceDays: v.toleranceDays,
    escalationStepDays: v.escalationStepDays,
    escalationAmountThreshold: v.escalationAmountThreshold,
    pickupOfferTtlHours: v.pickupOfferTtlHours,
    pickupWindowDays: v.pickupWindowDays,
    runHour: v.runHour,
    enabled: v.enabled === 1,
  };
}

/** Un envase retenido pasó la tolerancia cuando la entrega es anterior o igual al límite. */
export function superaLaTolerancia(
  entregadoEn: Date,
  ahora: Date,
  toleranceDays: number,
): boolean {
  return ahora.getTime() - entregadoEn.getTime() >= toleranceDays * MS_POR_DIA;
}

/** El aviso que corresponde a cada escalón: primero el recordatorio, después el del depósito. */
export function avisoDelEscalon(step: number): RecoveryNoticeKind {
  return step <= 1
    ? RecoveryNoticeKind.REMINDER
    : RecoveryNoticeKind.DEPOSIT_WARNING;
}

export function vencimientoDelEscalon(
  ahora: Date,
  p: ParametrosDeRecupero,
): Date {
  return new Date(ahora.getTime() + p.escalationStepDays * MS_POR_DIA);
}

export function vencimientoDeLaOferta(
  ahora: Date,
  p: ParametrosDeRecupero,
): Date {
  return new Date(ahora.getTime() + p.pickupOfferTtlHours * MS_POR_HORA);
}

export type PasoSiguiente =
  /** El escalón sigue en plazo: no hay nada para hacer. */
  | { accion: 'esperar' }
  /** El escalón no envió todavía su aviso (caso recién abierto). */
  | { accion: 'avisar'; step: number }
  /** Venció el plazo del escalón: pasa al siguiente y avisa. */
  | { accion: 'subir'; step: number }
  /** Venció el último escalón: se agota la secuencia. */
  | { accion: 'agotar' };

/**
 * Qué toca hacer con un caso abierto (CU-108, pasos 5, 7 y 10). `avisoEnviado`
 * es si el escalón actual ya mandó su recordatorio o aviso del depósito: con
 * eso la corrida es idempotente, dos pasadas seguidas no repiten el aviso.
 */
export function siguientePaso(
  caso: { step: number; stepDueAt: Date },
  avisoEnviado: boolean,
  ahora: Date,
): PasoSiguiente {
  if (!avisoEnviado) return { accion: 'avisar', step: caso.step };
  if (ahora.getTime() < caso.stepDueAt.getTime()) return { accion: 'esperar' };
  if (caso.step + 1 >= ESCALON_AGOTADO) return { accion: 'agotar' };
  return { accion: 'subir', step: caso.step + 1 };
}

/**
 * Cómo termina la secuencia agotada (paso 10 y su excepción): si el depósito
 * supera el umbral el caso se eleva al administrador; si no, queda registrado
 * como envase perdido y sólo se informa en el reporte.
 */
export function destinoAlAgotarse(
  depositAmount: number,
  umbral: number,
): RecoveryCaseStatus.ESCALATED | RecoveryCaseStatus.LOST {
  return new Decimal(depositAmount).greaterThan(umbral)
    ? RecoveryCaseStatus.ESCALATED
    : RecoveryCaseStatus.LOST;
}

/** Tiempo después de la entrega del pedido en que el chofer todavía puede confirmar el retiro. */
export const GRACIA_DEL_RETIRO_MS = 24 * MS_POR_HORA;

const PEDIDO_EN_PIE: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.RESERVED,
  OrderStatus.PENDING,
  OrderStatus.ACCEPTED,
  OrderStatus.ON_THE_WAY,
]);

const entregadoEnGracia = (
  pedido: Pick<OrderRecoveryRef, 'status' | 'deliveredAt'>,
  ahora: Date,
): boolean =>
  pedido.status === OrderStatus.DELIVERED &&
  pedido.deliveredAt !== null &&
  ahora.getTime() - pedido.deliveredAt.getTime() <= GRACIA_DEL_RETIRO_MS;

/**
 * Un retiro acordado sigue vigente mientras su pedido siga en pie o, ya
 * entregado, dentro de la gracia: el chofer puede confirmarlo después de dejar
 * el pedido. Cancelado o entregado hace más de 24 h, el retiro se da por fallido.
 */
export function retiroSigueVigente(
  pedido: Pick<OrderRecoveryRef, 'status' | 'deliveredAt'> | undefined,
  ahora: Date,
): boolean {
  if (!pedido) return false;
  return PEDIDO_EN_PIE.has(pedido.status) || entregadoEnGracia(pedido, ahora);
}

/** El chofer confirma el retiro con el pedido aceptado, en camino o entregado hace menos de 24 h. */
export function choferPuedeRetirar(
  pedido: Pick<OrderRecoveryRef, 'status' | 'deliveredAt'>,
  ahora: Date,
): boolean {
  return (
    pedido.status === OrderStatus.ACCEPTED ||
    pedido.status === OrderStatus.ON_THE_WAY ||
    entregadoEnGracia(pedido, ahora)
  );
}
