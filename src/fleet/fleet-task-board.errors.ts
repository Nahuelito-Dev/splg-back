import {
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import { CODIGOS_DE_ERROR, conCodigo } from '../common/errors/con-codigo';
import type { ResultadoDelMovimiento } from './domain/task-board';

/** Los errores del tablero de tareas de flota, con su `code` para el panel. */

/** 409 si la tarea cambió desde que el panel la leyó (`expectedUpdatedAt` / `If-Match`). */
export function assertSinCambiosAjenos(
  actual: Date,
  esperado: Date | undefined,
): void {
  if (esperado && actual.getTime() !== esperado.getTime()) {
    throw conCodigo(
      ConflictException,
      409,
      'La tarea cambió mientras la tenías abierta: actualizá el tablero y probá de nuevo',
      CODIGOS_DE_ERROR.FLEET_TASK_STALE,
    );
  }
}

export function tareaCerrada(hecha: boolean): ConflictException {
  return conCodigo(
    ConflictException,
    409,
    `La tarea ya está ${hecha ? 'hecha' : 'cancelada'}: no se mueve en el tablero`,
    CODIGOS_DE_ERROR.FLEET_TASK_CLOSED,
  );
}

export function vecinaInvalida(): BadRequestException {
  return conCodigo(
    BadRequestException,
    400,
    'La tarjeta de referencia no está en esa columna del tablero',
    CODIGOS_DE_ERROR.FLEET_TASK_NEIGHBOR_INVALID,
  );
}

/** El error del movimiento rechazado por la máquina de estados. */
export function movimientoRechazado(
  motivo: Exclude<ResultadoDelMovimiento, { ok: true }>['motivo'],
  hecha: boolean,
): HttpException {
  switch (motivo) {
    case 'cerrada':
      return tareaCerrada(hecha);
    case 'falta_el_turno':
      return conCodigo(
        BadRequestException,
        400,
        'Fecha programada: para pasar la tarea a «Programada» indicá cuándo es el turno',
        CODIGOS_DE_ERROR.FLEET_TASK_SCHEDULED_AT_REQUIRED,
      );
    case 'turno_fuera_de_lugar':
      return conCodigo(
        BadRequestException,
        400,
        'Fecha programada: sólo se indica al pasar la tarea a «Programada»',
        CODIGOS_DE_ERROR.FLEET_TASK_SCHEDULED_AT_NOT_ALLOWED,
      );
    case 'transicion_no_permitida':
      return conCodigo(
        ConflictException,
        409,
        'La tarea no puede pasar directo a esa columna: pasala primero por «Programada»',
        CODIGOS_DE_ERROR.FLEET_TASK_TRANSITION_NOT_ALLOWED,
      );
  }
}
