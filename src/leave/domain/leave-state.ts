/**
 * Reglas puras de las licencias y ausencias del personal (CU-191, CU-192,
 * CU-316, CU-317, CU-318): estados, períodos y superposiciones. Las fechas son
 * días calendario `YYYY-MM-DD` que se comparan como texto.
 */
export enum LeaveStatus {
  REQUESTED = 'requested',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
}

/** Los estados que ocupan el período del empleado: cuentan para la superposición y el despacho. */
export const ESTADOS_VIGENTES: readonly LeaveStatus[] = [
  LeaveStatus.REQUESTED,
  LeaveStatus.APPROVED,
];

export type RechazoDeLicencia =
  | 'FIN_ANTERIOR_AL_INICIO'
  | 'NO_ESTA_SOLICITADA'
  | 'YA_TERMINO'
  | 'YA_RESUELTA'
  | 'MOTIVO_OBLIGATORIO';

interface Periodo {
  startDate: string;
  endDate: string;
}

/** Cantidad de días corridos del período, ambos extremos incluidos. */
export function diasCorridos(inicio: string, fin: string): number {
  const ms = Date.parse(`${fin}T00:00:00Z`) - Date.parse(`${inicio}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

export function validarPeriodo(
  inicio: string,
  fin: string,
): RechazoDeLicencia | null {
  return fin < inicio ? 'FIN_ANTERIOR_AL_INICIO' : null;
}

/** Dos períodos (extremos incluidos) se pisan si alguno empieza antes de que el otro termine. */
export function sePisan(a: Periodo, b: Periodo): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

/** `true` si la licencia cubre ese día. */
export function cubreElDia(periodo: Periodo, dia: string): boolean {
  return periodo.startDate <= dia && dia <= periodo.endDate;
}

/** Sólo una licencia solicitada se modifica; una aprobada se cancela y se carga otra. */
export function validarModificacion(
  estado: LeaveStatus,
): RechazoDeLicencia | null {
  return estado === LeaveStatus.REQUESTED ? null : 'NO_ESTA_SOLICITADA';
}

/** Aprobar y rechazar parten de `requested`. */
export function validarResolucion(
  estado: LeaveStatus,
): RechazoDeLicencia | null {
  return estado === LeaveStatus.REQUESTED ? null : 'NO_ESTA_SOLICITADA';
}

export function validarRechazo(
  estado: LeaveStatus,
  motivo: string | undefined | null,
): RechazoDeLicencia | null {
  if (!motivo || motivo.trim() === '') return 'MOTIVO_OBLIGATORIO';
  return validarResolucion(estado);
}

/**
 * Cancelar: sirve para una solicitada o aprobada que no terminó. Una rechazada
 * o cancelada ya está resuelta; una cuyo último día pasó, terminó.
 */
export function validarCancelacion(
  licencia: { status: LeaveStatus; endDate: string },
  hoy: string,
): RechazoDeLicencia | null {
  if (
    licencia.status === LeaveStatus.REJECTED ||
    licencia.status === LeaveStatus.CANCELLED
  ) {
    return 'YA_RESUELTA';
  }
  return licencia.endDate < hoy ? 'YA_TERMINO' : null;
}
