import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'node:crypto';

/** Qué abrió la traza en curso. */
export type OrigenDeLaTraza = 'http' | 'cron' | 'webhook' | 'manual' | 'socket';

/**
 * Lo que viaja con cada request, corrida o evento sin pasarlo de mano en mano
 * (DISENO-OBSERVABILIDAD §4.1): el `traceId` une el request que entró, la
 * corrida que disparó, los asientos de auditoría y los avisos que generó.
 */
export interface Traza {
  traceId: string;
  origen: OrigenDeLaTraza;
  /** El request id del HTTP que la abrió, si vino de un request. */
  requestId?: string;
  /** La corrida de proceso en curso, si la hay. */
  runId?: string;
}

/** Largo máximo de un id de traza (el de `X-Request-Id` y las columnas `varchar(64)`). */
export const TRACE_ID_MAX = 64;

/** Lo único que se acepta en un id de traza: letras, dígitos, guion y guion bajo. */
export const TRACE_ID_VALIDO = /^[A-Za-z0-9_-]{1,64}$/;

const almacen = new AsyncLocalStorage<Traza>();

/**
 * El contexto de traza del código en curso. Se apoya en `AsyncLocalStorage`:
 * cada request y cada corrida tienen el suyo, aunque corran a la vez.
 */
export const ContextoDeTraza = {
  /** Corre `fn` dentro de la traza: todo lo asincrónico que arranque desde ahí la hereda. */
  abrir<T>(traza: Traza, fn: () => T): T {
    return almacen.run(traza, fn);
  },

  actual(): Traza | undefined {
    return almacen.getStore();
  },

  traceIdActual(): string | null {
    return almacen.getStore()?.traceId ?? null;
  },
};

/**
 * El id de traza que manda quien llama, si sirve: texto de 1 a 64 caracteres
 * con letras, dígitos, `-` o `_`. Cualquier otra cosa (vacío, largo, con
 * espacios, saltos de línea o caracteres que ensuciarían el log) no se usa.
 */
export function sanearTraceId(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpio = valor.trim();
  return TRACE_ID_VALIDO.test(limpio) ? limpio : null;
}

/**
 * Prefijo de los ids que manda quien llama (`X-Request-Id`). Los que genera el
 * server son uuid sin prefijo (requests sin id y corridas de cron, cuya traza
 * es su `run_id`), así un id elegido afuera nunca cae en la traza de otro.
 */
export const PREFIJO_DEL_CLIENTE = 'c-';

/** El id de traza para un `X-Request-Id` que manda quien llama: saneado y con prefijo. */
export function traceIdDelCliente(valor: unknown): string | null {
  const limpio = sanearTraceId(valor);
  if (!limpio || limpio.length > TRACE_ID_MAX - PREFIJO_DEL_CLIENTE.length) {
    return null;
  }
  return `${PREFIJO_DEL_CLIENTE}${limpio}`;
}

/** Un id de traza nuevo (uuid v4). */
export function nuevoTraceId(): string {
  return randomUUID();
}

/**
 * Lo que se antepone a cada línea del log: los primeros 8 caracteres del id
 * (sin el prefijo `c-` de los que manda quien llama, que no distingue nada).
 */
export function prefijoDeTraza(traceId: string): string {
  const id = traceId.startsWith(PREFIJO_DEL_CLIENTE)
    ? traceId.slice(PREFIJO_DEL_CLIENTE.length)
    : traceId;
  return `[t:${id.slice(0, 8)}]`;
}
