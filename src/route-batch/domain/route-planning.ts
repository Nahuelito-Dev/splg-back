/**
 * Armado y orden de los lotes de recorrido (CU-107, pasos 3 a 6). Funciones
 * puras: no leen la base ni el reloj, así que cada regla se prueba sola.
 */

/** Un pedido programado, sin chofer, que puede entrar a un lote. */
export interface PedidoCandidato {
  orderId: string;
  /** Inicio y fin de la franja comprometida, en milisegundos (instante real). */
  slotStartMs: number;
  slotEndMs: number;
  /** Kilos que carga el pedido (peso del envase por la cantidad). */
  weightKg: number;
  createdAtMs: number;
}

export interface ParametrosDeAgrupacion {
  maxBatchSize: number;
  groupingRadiusKm: number;
  slotToleranceMinutes: number;
}

/** Kilómetros en línea recta entre dos pedidos (PostGIS, `ST_Distance` sobre geography). */
export type DistanciaEntrePedidos = (a: string, b: string) => number;

/** Cuántos kilos puede llevar el vehículo; `null` si no tiene capacidad cargada (sin tope). */
export type CapacidadKg = number | null;

const MS_POR_MINUTO = 60_000;

/** Velocidad media urbana con la que se estima la llegada (km/h). */
export const VELOCIDAD_MEDIA_KMH = 30;
/** El recorrido real es más largo que la línea recta; el mismo 1,3 que usa M2. */
export const FACTOR_DE_CALLES = 1.3;
/** Lo que se demora en cada parada entre llegar y salir (minutos). */
export const MINUTOS_DE_SERVICIO = 10;

/**
 * Pasos 3 a 5: a partir de una semilla (el pedido con la franja más temprana)
 * suma pedidos mientras cada uno cumpla con TODOS los que ya están en el lote:
 * a no más del radio, con franjas que no difieran más que la tolerancia, sin
 * pasar el tamaño máximo ni la capacidad de carga. Devuelve los ids en el orden
 * en que se sumaron; un lote de uno no es un lote (el llamador lo descarta).
 */
export function armarGrupo(
  semilla: PedidoCandidato,
  restantes: readonly PedidoCandidato[],
  params: ParametrosDeAgrupacion,
  distancia: DistanciaEntrePedidos,
  capacidad: CapacidadKg,
): PedidoCandidato[] {
  const grupo = [semilla];
  let peso = semilla.weightKg;
  const toleranciaMs = params.slotToleranceMinutes * MS_POR_MINUTO;

  const compatibles = (p: PedidoCandidato): boolean =>
    p.orderId !== semilla.orderId &&
    grupo.every(
      (m) =>
        distancia(m.orderId, p.orderId) <= params.groupingRadiusKm &&
        Math.abs(m.slotStartMs - p.slotStartMs) <= toleranciaMs,
    );

  while (grupo.length < params.maxBatchSize) {
    const siguiente = restantes
      .filter(
        (p) =>
          !grupo.includes(p) &&
          compatibles(p) &&
          (capacidad === null || peso + p.weightKg <= capacidad),
      )
      // El más cercano a la semilla; a igual distancia, el más antiguo.
      .sort(
        (a, b) =>
          distancia(semilla.orderId, a.orderId) -
            distancia(semilla.orderId, b.orderId) ||
          a.createdAtMs - b.createdAtMs ||
          a.orderId.localeCompare(b.orderId),
      )[0];
    if (!siguiente) break;
    grupo.push(siguiente);
    peso += siguiente.weightKg;
  }
  return grupo;
}

export interface Parada {
  orderId: string;
  sequence: number;
  /** Llegada estimada (milisegundos); si llega antes de la franja, espera a que abra. */
  etaMs: number;
  /** Kilómetros desde la parada anterior (la primera: 0). */
  legDistanceKm: number;
}

export interface RecorridoOrdenado {
  paradas: Parada[];
  /** Pedidos que, en cualquier orden razonable, llegarían después de que cierre su franja. */
  excluidos: string[];
}

function minutosDeViaje(km: number): number {
  return ((km * FACTOR_DE_CALLES) / VELOCIDAD_MEDIA_KMH) * 60;
}

/**
 * Paso 6: ordena las paradas cumpliendo las franjas y acortando el camino.
 *
 * Heurística (vecino más cercano con verificación de franjas):
 *  1. La primera parada es la de la franja que abre antes (a igual franja, la
 *     más antigua): el chofer sale hacia ella.
 *  2. En cada paso, entre las paradas pendientes se consideran las "urgentes":
 *     las que ya abrieron o abren antes de que cierre la franja que cierra
 *     primero. De ésas, va la más cercana a donde está el chofer. Así nunca se
 *     deja para después una franja que se está por cerrar sólo por ahorrar un tramo.
 *  3. Se simula la llegada con la velocidad media y el tiempo de servicio. Si
 *     llega antes de que abra la franja, espera. Una parada que llegaría con la
 *     franja ya cerrada se saca del lote (queda para el despacho individual).
 *
 * No es el óptimo (es un problema de rutas con ventanas, NP-difícil): con lotes
 * de hasta 20 paradas alcanza y es explicable.
 */
export function ordenarParadas(
  grupo: readonly PedidoCandidato[],
  distancia: DistanciaEntrePedidos,
): RecorridoOrdenado {
  const pendientes = [...grupo];
  const paradas: Parada[] = [];
  const excluidos: string[] = [];
  let actual: PedidoCandidato | null = null;
  let reloj = 0;

  while (pendientes.length > 0) {
    const cierraPrimero = Math.min(...pendientes.map((p) => p.slotEndMs));
    const urgentes = pendientes.filter((p) => p.slotStartMs <= cierraPrimero);
    const elegido: PedidoCandidato =
      actual === null
        ? [...urgentes].sort(
            (a, b) =>
              a.slotStartMs - b.slotStartMs ||
              a.createdAtMs - b.createdAtMs ||
              a.orderId.localeCompare(b.orderId),
          )[0]
        : [...urgentes].sort(
            (a, b) =>
              distancia(actual!.orderId, a.orderId) -
                distancia(actual!.orderId, b.orderId) ||
              a.slotStartMs - b.slotStartMs ||
              a.orderId.localeCompare(b.orderId),
          )[0];
    pendientes.splice(pendientes.indexOf(elegido), 1);

    const tramo =
      actual === null ? 0 : distancia(actual.orderId, elegido.orderId);
    const llegada =
      actual === null
        ? elegido.slotStartMs
        : reloj + minutosDeViaje(tramo) * MS_POR_MINUTO;
    const efectiva = Math.max(llegada, elegido.slotStartMs);
    if (efectiva > elegido.slotEndMs) {
      excluidos.push(elegido.orderId);
      continue;
    }
    paradas.push({
      orderId: elegido.orderId,
      sequence: paradas.length + 1,
      etaMs: Math.round(efectiva),
      legDistanceKm: Math.round(tramo * 100) / 100,
    });
    reloj = efectiva + MINUTOS_DE_SERVICIO * MS_POR_MINUTO;
    actual = elegido;
  }
  return { paradas, excluidos };
}

/** Los kilos de un conjunto de pedidos, redondeado a 2 decimales como la columna. */
export function pesoTotal(pedidos: readonly PedidoCandidato[]): number {
  return (
    Math.round(pedidos.reduce((acc, p) => acc + p.weightKg, 0) * 100) / 100
  );
}
