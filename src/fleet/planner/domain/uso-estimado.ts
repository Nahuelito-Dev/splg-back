import { diasEntre, sumarDias } from '../../../common/utils/dias-argentina';

/** Kilómetros de un vehículo en un día (`YYYY-MM-DD`, hora argentina), del registro de uso. */
export interface MuestraDeUso {
  day: string;
  km: number;
}

export interface ParametrosDeEstimacion {
  /** Peso de cada semana respecto de la siguiente más reciente (0 a 1). */
  decay: number;
  /** Días CON REGISTRO exigidos para confiar en la estimación propia. */
  minSampleDays: number;
  /** Si el último registro es de hace más días que éstos, los datos están desactualizados. */
  staleDays: number;
}

export interface UsoEstimado {
  kmPorDia: number;
  /** Días con registro que entraron en la estimación. */
  diasConDato: number;
  /** El último día con registro. */
  ultimoDia: string;
  /** El último registro es más viejo que `staleDays`: no se proyecta con él. */
  desactualizado: boolean;
}

/** Cuántas semanas hacia atrás pesa la media móvil. */
const SEMANAS_MAXIMAS = 13;
const FACTOR_MINIMO = 0.7;
const FACTOR_MAXIMO = 1.3;
/** Registros de un mes que se piden antes de creerle a la estacionalidad. */
const MUESTRAS_MINIMAS_POR_MES = 7;

/**
 * Kilómetros por día de uso del vehículo: media de los días CON registro (un
 * día sin registro, o con 0 km, no es un día sin uso: es un día sin dato, el sábado sin
 * entregas o un hueco del registro), con más peso en las semanas recientes
 * (cada semana pesa `decay` veces la siguiente). `null` si hay menos días con
 * registro que `minSampleDays`. Si el último registro es más viejo que
 * `staleDays` devuelve la estimación marcada `desactualizado`: quien proyecta
 * no tiene que usarla (un vehículo parado no es un vehículo que anda poco).
 */
export function estimarKmPorDia(
  muestras: readonly MuestraDeUso[],
  hoy: string,
  { decay, minSampleDays, staleDays }: ParametrosDeEstimacion,
): UsoEstimado | null {
  const limite = sumarDias(hoy, -7 * SEMANAS_MAXIMAS);
  const validas = muestras.filter(
    (m) => m.day <= hoy && m.day >= limite && Number.isFinite(m.km) && m.km > 0,
  );
  if (validas.length < Math.max(1, minSampleDays)) return null;

  let suma = 0;
  let pesos = 0;
  let ultimoDia = validas[0].day;
  for (const m of validas) {
    const peso = Math.pow(decay, Math.floor(diasEntre(m.day, hoy) / 7));
    suma += peso * m.km;
    pesos += peso;
    if (m.day > ultimoDia) ultimoDia = m.day;
  }
  if (pesos === 0) return null;
  return {
    kmPorDia: suma / pesos,
    diasConDato: validas.length,
    ultimoDia,
    desactualizado: diasEntre(ultimoDia, hoy) > staleDays,
  };
}

/**
 * Corrección por estacionalidad: cuánto más (o menos) anda el vehículo en
 * `mes` (1 a 12) que en el resto del año, sobre los días con uso registrado.
 * Vale 1 si el historial no cubre dos meses distintos o el mes pedido tiene
 * pocos registros; se acota a 0,7–1,3 para que un mes raro no desarme la proyección.
 */
export function factorDeEstacionalidad(
  muestras: readonly MuestraDeUso[],
  mes: number,
): number {
  const delMes = muestras.filter((m) => Number(m.day.slice(5, 7)) === mes);
  const meses = new Set(muestras.map((m) => m.day.slice(0, 7)));
  if (meses.size < 2 || delMes.length < MUESTRAS_MINIMAS_POR_MES) return 1;
  const promedio = (xs: readonly MuestraDeUso[]) =>
    xs.reduce((a, m) => a + m.km, 0) / xs.length;
  const general = promedio(muestras);
  if (general <= 0) return 1;
  return Math.min(
    FACTOR_MAXIMO,
    Math.max(FACTOR_MINIMO, promedio(delMes) / general),
  );
}

/** Mes (1 a 12) del día `hoy` más `dias`. */
export function mesDentroDe(hoy: string, dias: number): number {
  return Number(sumarDias(hoy, dias).slice(5, 7));
}

/** Promedio de los kmPorDia de otros vehículos del mismo tipo (respaldo sin historial propio). */
export function promedioDeFlota(valores: readonly number[]): number | null {
  if (valores.length === 0) return null;
  return valores.reduce((a, v) => a + v, 0) / valores.length;
}
