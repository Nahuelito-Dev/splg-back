import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  diaArgentino,
  inicioDelDiaArgentino,
  minutosDelDiaArgentino,
} from '../common/utils/dias-argentina';
import { CODIGOS_DE_ERROR, conCodigo } from '../common/errors/con-codigo';
import type { PlanningCaseCloser } from './planner/planning-case-closer.service';

/**
 * El turno agendado de una tarea (`scheduledAt`): cómo se lee lo que manda el
 * panel y cómo lo sigue la ventana confirmada del planificador de taller
 * (CU-105). Lo comparten la edición de la tarea y el tablero.
 */

/** Lo que pidió el cuerpo para `scheduledAt`: sólo un día, un instante con hora, o borrarlo. */
export type TurnoPedido =
  | { tipo: 'borrar' }
  | { tipo: 'dia'; dia: string }
  | { tipo: 'instante'; inicio: Date };

const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `undefined` no se toca. `YYYY-MM-DD` o un instante a medianoche argentina
 * (lo que manda un selector de fecha) es «sólo fecha»; cualquier otro instante
 * trae hora propia.
 */
export function turnoPedido(
  valor: string | null | undefined,
): TurnoPedido | undefined {
  if (valor === undefined) return undefined;
  if (!valor) return { tipo: 'borrar' };
  if (SOLO_FECHA.test(valor)) return { tipo: 'dia', dia: valor };
  const inicio = new Date(valor);
  const aMedianoche =
    minutosDelDiaArgentino(inicio) === 0 &&
    inicio.getUTCSeconds() === 0 &&
    inicio.getUTCMilliseconds() === 0;
  return aMedianoche
    ? { tipo: 'dia', dia: diaArgentino(inicio) }
    : { tipo: 'instante', inicio };
}

/** ¿El turno pedido es el que la tarea ya tiene? Un día se compara como lo muestra el panel: 00:00Z exacto = día UTC, otro instante = día argentino. */
export function mismoTurno(
  pedido: TurnoPedido,
  guardado: Date | null,
): boolean {
  if (pedido.tipo === 'borrar') return guardado === null;
  if (guardado === null) return false;
  if (pedido.tipo === 'instante') {
    return guardado.getTime() === pedido.inicio.getTime();
  }
  // Mismo criterio que el panel: 00:00Z exacto es una fila vieja (día de calendario UTC); el resto, día argentino.
  const filaVieja = guardado.getTime() % 86_400_000 === 0;
  return (
    (filaVieja
      ? guardado.toISOString().slice(0, 10)
      : diaArgentino(guardado)) === pedido.dia
  );
}

/** Las 00:00 de Argentina de ese día, o 400 si el día no existe. */
export function inicioDelDiaOFalla(dia: string): Date {
  const inicio = inicioDelDiaArgentino(dia);
  if (!inicio) {
    throw conCodigo(
      BadRequestException,
      400,
      `scheduledAt: día inválido (${dia})`,
      CODIGOS_DE_ERROR.SCHEDULED_DAY_INVALID,
    );
  }
  return inicio;
}

/**
 * El turno que queda guardado, dentro de la transacción y con la tarea
 * bloqueada. `undefined`: no cambia (no se pidió, o es el mismo). Si cambia de
 * verdad, la ventana confirmada del planificador lo sigue (también el bloqueo
 * del despacho) o se cancela si se borra.
 */
export async function resolverTurno(
  manager: EntityManager,
  casos: PlanningCaseCloser | undefined,
  taskId: string,
  pedido: TurnoPedido | undefined,
  guardado: Date | null,
  userId: string | null,
): Promise<Date | null | undefined> {
  if (!pedido || mismoTurno(pedido, guardado)) return undefined;
  const destino =
    pedido.tipo === 'borrar'
      ? null
      : pedido.tipo === 'dia'
        ? { dia: pedido.dia }
        : { inicio: pedido.inicio };
  const ventana = await casos?.reprogramarConfirmado(
    manager,
    taskId,
    destino,
    userId,
  );
  return (
    ventana ??
    (pedido.tipo === 'borrar'
      ? null
      : pedido.tipo === 'instante'
        ? pedido.inicio
        : inicioDelDiaOFalla(pedido.dia))
  );
}
