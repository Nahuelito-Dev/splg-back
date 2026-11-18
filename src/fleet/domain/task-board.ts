/**
 * Tablero de tareas de flota: columnas, máquina de estados del movimiento y
 * orden fraccional dentro de una columna. Reglas puras: no importan Nest ni
 * TypeORM (CONVENCIONES §3).
 *
 * Las columnas son `forecast`, `scheduled`, `in_progress` y `done`. Una tarea
 * `overdue` (estado heredado: hoy nadie lo escribe) va a la columna de la que
 * viene según su turno; la vencida por fecha se marca con `isOverdue` y no
 * cambia de columna. `cancelled` no tiene columna: se cuenta aparte.
 */

export enum BoardColumn {
  FORECAST = 'forecast',
  SCHEDULED = 'scheduled',
  IN_PROGRESS = 'in_progress',
  DONE = 'done',
}

/** Las columnas a las que se arrastra una tarjeta: a «hecha» se llega por el cierre. */
export enum BoardMoveTarget {
  FORECAST = 'forecast',
  SCHEDULED = 'scheduled',
  IN_PROGRESS = 'in_progress',
}

/** Los estados de `MaintenanceTaskStatus`, sin depender de la entidad. */
export type EstadoDeTarea =
  | 'forecast'
  | 'scheduled'
  | 'in_progress'
  | 'done'
  | 'overdue'
  | 'cancelled';

/** Separación entre dos tarjetas seguidas al numerar una columna. */
export const PASO_DE_POSICION = 1024;

/** Por debajo de esta distancia entre vecinas, la columna se renumera. */
export const HUECO_MINIMO = 1e-6;

/** La columna de una tarea, o `null` si está cancelada. */
export function columnaDe(tarea: {
  status: `${EstadoDeTarea}`;
  scheduledAt: Date | null;
}): BoardColumn | null {
  switch (tarea.status) {
    case 'forecast':
      return BoardColumn.FORECAST;
    case 'scheduled':
      return BoardColumn.SCHEDULED;
    case 'in_progress':
      return BoardColumn.IN_PROGRESS;
    case 'done':
      return BoardColumn.DONE;
    case 'overdue':
      return tarea.scheduledAt ? BoardColumn.SCHEDULED : BoardColumn.FORECAST;
    case 'cancelled':
      return null;
  }
}

/** Cómo queda el turno de la tarea después del movimiento. */
export type TurnoTrasMover = 'conservar' | 'borrar' | 'fijar';

export type ResultadoDelMovimiento =
  | {
      ok: true;
      /** El estado nuevo (`null`: sólo se reordena y el estado no cambia). */
      estado: EstadoDeTarea | null;
      turno: TurnoTrasMover;
    }
  | {
      ok: false;
      motivo:
        | 'cerrada'
        | 'transicion_no_permitida'
        | 'falta_el_turno'
        | 'turno_fuera_de_lugar';
    };

/**
 * Transiciones del tablero:
 *
 * - `forecast → scheduled` exige el turno; `scheduled → forecast` lo borra.
 * - `scheduled ↔ in_progress`.
 * - Misma columna: sólo reordena (el turno no se toca).
 * - Desde `done` o `cancelled`, nada.
 *
 * Un turno nuevo sólo se acepta al ir a `scheduled`: desde `forecast` es
 * obligatorio; desde `scheduled` o `in_progress`, opcional (reprograma).
 */
export function resolverMovimiento(
  tarea: { status: `${EstadoDeTarea}`; scheduledAt: Date | null },
  destino: BoardMoveTarget,
  conTurno: boolean,
): ResultadoDelMovimiento {
  const origen = columnaDe(tarea);
  if (origen === null || origen === BoardColumn.DONE) {
    return { ok: false, motivo: 'cerrada' };
  }
  if (conTurno && destino !== BoardMoveTarget.SCHEDULED) {
    return { ok: false, motivo: 'turno_fuera_de_lugar' };
  }
  if ((origen as string) === (destino as string)) {
    return { ok: true, estado: null, turno: conTurno ? 'fijar' : 'conservar' };
  }
  switch (`${origen}>${destino}`) {
    case 'forecast>scheduled':
      return conTurno
        ? { ok: true, estado: 'scheduled', turno: 'fijar' }
        : { ok: false, motivo: 'falta_el_turno' };
    case 'scheduled>forecast':
      return { ok: true, estado: 'forecast', turno: 'borrar' };
    case 'scheduled>in_progress':
      return { ok: true, estado: 'in_progress', turno: 'conservar' };
    case 'in_progress>scheduled':
      return {
        ok: true,
        estado: 'scheduled',
        turno: conTurno ? 'fijar' : 'conservar',
      };
    default:
      return { ok: false, motivo: 'transicion_no_permitida' };
  }
}

/** Una tarjeta de la columna con su posición (`null`: todavía sin numerar). */
export interface Ubicada {
  id: string;
  position: number | null;
}

export type PosicionCalculada =
  | { ok: true; posicion: number }
  | { ok: false; motivo: 'renumerar' | 'vecinas_invertidas' };

/**
 * La posición de una tarjeta en una columna ya ordenada (sin la tarjeta que se
 * mueve). `afterId`: queda inmediatamente después de esa; `beforeId`:
 * inmediatamente antes. Sin ninguna, al final. Con las dos, entre ambas (la de
 * `afterId` tiene que estar antes que la de `beforeId`).
 *
 * Pide renumerar la columna si alguna tarjeta involucrada no tiene posición o
 * si el hueco entre las vecinas ya es demasiado chico.
 */
export function calcularPosicion(
  columna: readonly Ubicada[],
  vecinas: { afterId?: string; beforeId?: string },
): PosicionCalculada {
  const indice = (id: string) => columna.findIndex((t) => t.id === id);
  let anterior: Ubicada | undefined;
  let siguiente: Ubicada | undefined;

  if (vecinas.afterId && vecinas.beforeId) {
    const a = indice(vecinas.afterId);
    const b = indice(vecinas.beforeId);
    if (a >= b) return { ok: false, motivo: 'vecinas_invertidas' };
    anterior = columna[a];
    siguiente = columna[b];
  } else if (vecinas.afterId) {
    const a = indice(vecinas.afterId);
    anterior = columna[a];
    siguiente = columna[a + 1];
  } else if (vecinas.beforeId) {
    const b = indice(vecinas.beforeId);
    anterior = b > 0 ? columna[b - 1] : undefined;
    siguiente = columna[b];
  } else {
    anterior = columna[columna.length - 1];
  }

  if (
    (anterior && anterior.position === null) ||
    (siguiente && siguiente.position === null)
  ) {
    return { ok: false, motivo: 'renumerar' };
  }
  const bajo = anterior?.position ?? null;
  const alto = siguiente?.position ?? null;
  if (bajo === null && alto === null) {
    return { ok: true, posicion: PASO_DE_POSICION };
  }
  if (alto === null)
    return { ok: true, posicion: (bajo as number) + PASO_DE_POSICION };
  if (bajo === null) return { ok: true, posicion: alto - PASO_DE_POSICION };
  if (alto - bajo < HUECO_MINIMO) return { ok: false, motivo: 'renumerar' };
  return { ok: true, posicion: bajo + (alto - bajo) / 2 };
}

/** Los estados que caen en una columna del tablero (`overdue` puede caer en dos, según el turno). */
export function estadosDeLaColumna(columna: BoardColumn): EstadoDeTarea[] {
  switch (columna) {
    case BoardColumn.FORECAST:
      return ['forecast', 'overdue'];
    case BoardColumn.SCHEDULED:
      return ['scheduled', 'overdue'];
    case BoardColumn.IN_PROGRESS:
      return ['in_progress'];
    case BoardColumn.DONE:
      return ['done'];
  }
}

/** Numeración pareja de una columna en su orden actual: `PASO, 2·PASO, …`. */
export function renumerar(columna: readonly Ubicada[]): Ubicada[] {
  return columna.map((t, i) => ({
    id: t.id,
    position: (i + 1) * PASO_DE_POSICION,
  }));
}
