/**
 * Tiempo de atención aprendido (M4): de las duraciones «Llegué» → entrega
 * confirmada de los últimos días saca la mediana y el p90 que usa la
 * planificación. Puro: la consulta de las muestras está en el servicio.
 */

/** Días de historia que se miran. */
export const VENTANA_DIAS = 30;
/** Menos entregas válidas que esto: no se aprende, rige el fijo. */
export const MUESTRAS_MINIMAS = 20;
/** Una atención de más de tres horas es un olvido del chofer, no una entrega. */
export const DURACION_MAXIMA_VALIDA_MIN = 180;
/** Fracción que se descarta en cada punta antes de calcular. */
export const RECORTE_POR_PUNTA = 0.05;
/** El rango que admite `serviceMinutes`. */
export const MINUTOS_MIN = 1;
export const MINUTOS_MAX = 60;

export interface TiempoDeAtencion {
  /** Entregas válidas de la ventana. */
  samples: number;
  /** `null` si no hay muestras suficientes. */
  medianMin: number | null;
  p90Min: number | null;
}

const redondear = (n: number): number => Math.round(n * 100) / 100;

const recortar = (n: number): number =>
  Math.min(MINUTOS_MAX, Math.max(MINUTOS_MIN, n));

/** Percentil por interpolación lineal sobre una lista ordenada. */
export function percentil(ordenados: readonly number[], p: number): number {
  if (ordenados.length === 0) return 0;
  const pos = (ordenados.length - 1) * p;
  const abajo = Math.floor(pos);
  const arriba = Math.ceil(pos);
  return (
    ordenados[abajo] + (ordenados[arriba] - ordenados[abajo]) * (pos - abajo)
  );
}

/**
 * Las duraciones en minutos de las entregas (una por parada). Se descartan las
 * no positivas y las de más de `DURACION_MAXIMA_VALIDA_MIN`; con al menos
 * `MUESTRAS_MINIMAS` válidas se recorta el 5 % de cada punta y se calculan
 * mediana y p90, llevados al rango 1–60.
 */
export function calcularTiempoDeAtencion(
  duracionesMin: readonly number[],
): TiempoDeAtencion {
  const validas = duracionesMin
    .filter(
      (m) => Number.isFinite(m) && m > 0 && m <= DURACION_MAXIMA_VALIDA_MIN,
    )
    .sort((a, b) => a - b);
  if (validas.length < MUESTRAS_MINIMAS) {
    return { samples: validas.length, medianMin: null, p90Min: null };
  }
  const corte = Math.floor(validas.length * RECORTE_POR_PUNTA);
  const centro = validas.slice(corte, validas.length - corte);
  const mediana = recortar(percentil(centro, 0.5));
  const p90 = Math.max(mediana, recortar(percentil(centro, 0.9)));
  return {
    samples: validas.length,
    medianMin: redondear(mediana),
    p90Min: redondear(p90),
  };
}

/**
 * Los minutos de servicio con que se planifica: el fijo del administrador, o
 * la mediana aprendida (entera, de 1 a 60) si eligió `learned` y hay muestra.
 */
export function minutosDeServicio(
  fijo: number,
  modo: 'fixed' | 'learned',
  aprendido: number | null,
): number {
  if (modo !== 'learned' || aprendido === null) return fijo;
  return recortar(Math.round(aprendido));
}
