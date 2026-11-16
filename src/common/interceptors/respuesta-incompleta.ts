import { AsyncLocalStorage } from 'async_hooks';

/**
 * Estado del request idempotente en curso. Lo abre `IdempotencyInterceptor`
 * alrededor del handler; fuera de uno no hay estado y marcar no hace nada.
 */
const estado = new AsyncLocalStorage<{ incompleta: boolean }>();

/** Corre `fn` con el estado abierto y dice si el handler marcó su respuesta incompleta. */
export async function conRespuestaVigilada<T>(
  fn: () => Promise<T>,
): Promise<{ valor: T; incompleta: boolean }> {
  const actual = { incompleta: false };
  const valor = await estado.run(actual, fn);
  return { valor, incompleta: actual.incompleta };
}

/**
 * El handler avisa que, aunque la operación quedó confirmada, no pudo armar la
 * respuesta completa (falló la relectura) y devolvió lo que tenía. La
 * idempotencia la guarda poco tiempo en vez de 24 h: alcanza para que un
 * reintento inmediato no repita la operación, y no deja un pedido a medias
 * como "la respuesta" de esa clave.
 */
export function marcarRespuestaIncompleta(): void {
  const actual = estado.getStore();
  if (actual) actual.incompleta = true;
}
