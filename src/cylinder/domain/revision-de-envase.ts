import { CylinderInspectionResult } from './cylinder-inspection-result';
import {
  diaArgentino,
  diaDeTexto,
  finDelDia,
  inicioDelDia,
} from './dia-calendario';
import { ReglaDeEnvaseError } from './errors/cylinder-rule.errors';

/** Lo que se carga de una revisión periódica (prueba hidráulica). */
export interface DatosDeRevision {
  /** Día de la revisión (`YYYY-MM-DD` o ISO; se toma la parte de fecha). */
  inspectedAt: string;
  result: CylinderInspectionResult;
  /** Último día en que puede circular; obligatorio salvo rechazo. */
  nextDueAt?: string;
  notes?: string;
}

/** La revisión con sus fechas resueltas en el calendario de Buenos Aires. */
export interface RevisionPlanificada {
  /** 00:00 (Buenos Aires) del día de la revisión. */
  inspectedAt: Date;
  /** 23:59:59.999 (Buenos Aires) del día de vencimiento; `null` en un rechazo. */
  vence: Date | null;
  rechazada: boolean;
  result: CylinderInspectionResult;
  notes: string | null;
}

/**
 * Valida las fechas de una revisión y las lleva a instantes. La revisión es de
 * un día de calendario y el envase vale hasta el final del día de su
 * vencimiento. En un rechazo el próximo vencimiento se ignora.
 */
export function planificarRevision(
  datos: DatosDeRevision,
  ahora: Date,
): RevisionPlanificada {
  const rechazada = datos.result === CylinderInspectionResult.REJECTED;
  const diaRevision = diaDeTexto(datos.inspectedAt);
  if (diaRevision > diaArgentino(ahora)) {
    throw new ReglaDeEnvaseError('La fecha de la revisión no puede ser futura');
  }
  let diaVencimiento: string | null = null;
  if (!rechazada) {
    if (!datos.nextDueAt) {
      throw new ReglaDeEnvaseError(
        'La fecha del próximo vencimiento es obligatoria si la revisión no fue rechazada',
      );
    }
    diaVencimiento = diaDeTexto(datos.nextDueAt);
    if (diaVencimiento <= diaRevision) {
      throw new ReglaDeEnvaseError(
        'El vencimiento tiene que ser posterior a la fecha de la revisión',
      );
    }
  }
  return {
    inspectedAt: inicioDelDia(diaRevision),
    vence: diaVencimiento ? finDelDia(diaVencimiento) : null,
    rechazada,
    result: datos.result,
    notes: datos.notes ?? null,
  };
}
