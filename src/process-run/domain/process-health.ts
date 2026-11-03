import {
  periodoEsperadoSeg,
  ProcessHealth,
  ProcessName,
  ProcessRunStatus,
} from './process-catalog';

/** Una corrida se considera atrasada si no arrancó en 1,5 veces su período. */
export const FACTOR_DE_ATRASO = 1.5;

export interface UltimaCorrida {
  status: ProcessRunStatus;
  startedAt: Date;
}

/**
 * El estado que se muestra de un proceso, según su última corrida:
 *  - `stuck`: sigue `running` hace más de `cuelgaMinutos`.
 *  - `running`: corre y todavía está a tiempo.
 *  - `failed`: la última terminó con error (aunque además esté atrasada).
 *  - `late`: la última arrancó hace más de 1,5 períodos (el borde exacto no es atraso).
 *  - `partial` / `ok`: resultado de la última.
 *  - `never`: no hay ninguna.
 */
export function evaluarSalud(
  ultima: UltimaCorrida | null,
  proceso: ProcessName,
  ahora: Date,
  cuelgaMinutos: number,
): ProcessHealth {
  if (!ultima) return ProcessHealth.NEVER;
  const transcurridoSeg = (ahora.getTime() - ultima.startedAt.getTime()) / 1000;
  if (ultima.status === ProcessRunStatus.RUNNING) {
    return transcurridoSeg > cuelgaMinutos * 60
      ? ProcessHealth.STUCK
      : ProcessHealth.RUNNING;
  }
  if (ultima.status === ProcessRunStatus.FAILED) return ProcessHealth.FAILED;
  if (transcurridoSeg > FACTOR_DE_ATRASO * periodoEsperadoSeg(proceso)) {
    return ProcessHealth.LATE;
  }
  return ultima.status === ProcessRunStatus.PARTIAL
    ? ProcessHealth.PARTIAL
    : ProcessHealth.OK;
}

/** Cuándo se espera la próxima corrida. */
export function proximaEsperada(startedAt: Date, proceso: ProcessName): Date {
  return new Date(startedAt.getTime() + periodoEsperadoSeg(proceso) * 1000);
}

/** Los estados que disparan un aviso al administrador. */
export const SALUD_CON_ALERTA: ReadonlySet<ProcessHealth> = new Set([
  ProcessHealth.LATE,
  ProcessHealth.FAILED,
  ProcessHealth.STUCK,
]);
