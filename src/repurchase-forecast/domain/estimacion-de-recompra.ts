import { diaArgentino, sumarDias } from '../../common/utils/dias-argentina';
import { estimarProximaRecompra } from '../../repurchase/domain/consumption';

const MS_POR_DIA = 86_400_000;
const DIAS_POR_MES = 30;
/** Cuántas compras hacia atrás cuentan como mínimo: el consumo de hace dos años no es el de hoy. Con un `minOrders` mayor cuentan tantas como éste pida. */
const COMPRAS_MAXIMAS = 13;
/** Un intervalo cuyo ritmo se aleja más de esto de la mediana es atípico (vacaciones, compra doble). */
const FACTOR_DE_ATIPICO = 3;
/** Tope de la proyección día por día: un consumo ínfimo no cuelga el proceso. */
const DIAS_MAXIMOS_DE_PROYECCION = 730;

/**
 * Cuánto pesa el consumo de gas de cada mes frente al promedio del año en el
 * NEA/centro del país (1 = promedio). Invierno gasta más que verano; se usa para
 * que una compra de julio no proyecte el ritmo de enero.
 */
export const COEFICIENTE_DE_ESTACIONALIDAD: Readonly<Record<number, number>> = {
  1: 0.7,
  2: 0.7,
  3: 0.8,
  4: 0.95,
  5: 1.15,
  6: 1.35,
  7: 1.4,
  8: 1.3,
  9: 1.05,
  10: 0.9,
  11: 0.75,
  12: 0.7,
};

export interface CompraEntregada {
  deliveredAt: Date;
  /** Kilos de gas que llevaba la compra. */
  kg: number;
}

export interface ParametrosDeEstimacion {
  /** Compras mínimas en el historial para estimar con él. */
  minOrders: number;
  /** Una estimación vencida hace más de estos días se descarta: el cliente dejó de comprar. */
  staleDays: number;
}

/** De dónde sale la fecha estimada: las compras del cliente o el consumo que declaró. */
export enum RepurchaseEstimateSource {
  HISTORY = 'history',
  DECLARED = 'declared',
}

export type MotivoSinEstimacion =
  | 'no_purchases'
  | 'insufficient_history'
  | 'irregular_history'
  | 'stale';

export interface EstimacionDeRecompra {
  ok: true;
  /** Cuándo se le acaba el gas. */
  estimatedAt: Date;
  source: RepurchaseEstimateSource;
  /** Kilos por día que se le estiman (promedio, sin estacionalidad). */
  kgPerDay: number;
  /** Compras que entraron en la estimación. */
  ordersUsed: number;
  lastDeliveredAt: Date;
  lastKg: number;
}

export type ResultadoDeEstimacion =
  | EstimacionDeRecompra
  | { ok: false; reason: MotivoSinEstimacion };

function coeficienteDelDia(dia: string): number {
  return COEFICIENTE_DE_ESTACIONALIDAD[Number(dia.slice(5, 7))] ?? 1;
}

/** Suma del coeficiente de cada día de `desde` (inclusive) a `hasta` (exclusive). */
function diasPonderados(desde: string, hasta: string): number {
  let suma = 0;
  for (let dia = desde; dia < hasta; dia = sumarDias(dia, 1)) {
    suma += coeficienteDelDia(dia);
  }
  return suma;
}

function mediana(valores: readonly number[]): number {
  const orden = [...valores].sort((a, b) => a - b);
  const medio = Math.floor(orden.length / 2);
  return orden.length % 2 === 1
    ? orden[medio]
    : (orden[medio - 1] + orden[medio]) / 2;
}

/** Las compras de un mismo día argentino son una sola: el gas se consume entre días. */
function compraPorDia(compras: readonly CompraEntregada[]): CompraEntregada[] {
  const porDia = new Map<string, CompraEntregada>();
  for (const c of [...compras].sort(
    (a, b) => a.deliveredAt.getTime() - b.deliveredAt.getTime(),
  )) {
    const dia = diaArgentino(c.deliveredAt);
    const previa = porDia.get(dia);
    porDia.set(
      dia,
      previa ? { deliveredAt: c.deliveredAt, kg: previa.kg + c.kg } : { ...c },
    );
  }
  return [...porDia.values()];
}

/**
 * Kilos por día base del cliente a partir de sus compras: lo que cada compra
 * duró hasta la siguiente, ponderado por kilos (una compra grande pesa más que
 * una chica) y descontando la estacionalidad del período. Los intervalos
 * atípicos se descartan. `null` si no quedan los intervalos que pide `minOrders`.
 */
function ritmoBase(
  compras: readonly CompraEntregada[],
  minOrders: number,
): { base: number; intervalos: number } | null {
  const recientes = compras.slice(-Math.max(COMPRAS_MAXIMAS, minOrders));
  const tramos: Array<{ kg: number; ponderados: number }> = [];
  for (let i = 1; i < recientes.length; i++) {
    const desde = diaArgentino(recientes[i - 1].deliveredAt);
    const hasta = diaArgentino(recientes[i].deliveredAt);
    const ponderados = diasPonderados(desde, hasta);
    if (ponderados > 0) tramos.push({ kg: recientes[i - 1].kg, ponderados });
  }
  if (tramos.length === 0) return null;
  const medianaDelRitmo = mediana(tramos.map((t) => t.kg / t.ponderados));
  const validos = tramos.filter((t) => {
    const ritmo = t.kg / t.ponderados;
    return (
      ritmo <= medianaDelRitmo * FACTOR_DE_ATIPICO &&
      ritmo >= medianaDelRitmo / FACTOR_DE_ATIPICO
    );
  });
  if (validos.length < Math.max(1, minOrders - 1)) return null;
  const kg = validos.reduce((a, t) => a + t.kg, 0);
  const ponderados = validos.reduce((a, t) => a + t.ponderados, 0);
  return { base: kg / ponderados, intervalos: validos.length };
}

/**
 * Proyecta día por día cuándo se consume `kg` partiendo de `desde` con el
 * ritmo base corregido por la estacionalidad de cada día.
 */
function proyectarAgotamiento(desde: Date, kg: number, base: number): Date {
  let restante = kg;
  let dia = diaArgentino(desde);
  let transcurridos = 0;
  while (transcurridos < DIAS_MAXIMOS_DE_PROYECCION) {
    const gasto = base * coeficienteDelDia(dia);
    if (gasto >= restante) {
      transcurridos += restante / gasto;
      return new Date(desde.getTime() + Math.round(transcurridos * MS_POR_DIA));
    }
    restante -= gasto;
    transcurridos += 1;
    dia = sumarDias(dia, 1);
  }
  return new Date(desde.getTime() + DIAS_MAXIMOS_DE_PROYECCION * MS_POR_DIA);
}

/**
 * Estima cuándo se le acaba el gas a un cliente (CU-106 y CU-146).
 *
 * - Con al menos `minOrders` compras y un ritmo estable, se estima con su
 *   historial (`history`).
 * - Sin historia suficiente, o con una irregular, se usa el consumo que declaró
 *   (`declared`, CU-143 y CU-144) desde su última compra.
 * - Sin ninguno de los dos, o sin compras, no se proyecta.
 * - Si la fecha ya pasó hace más de `staleDays`, el cliente dejó de comprar y no
 *   se proyecta.
 */
export function estimarRecompra(
  comprasEntregadas: readonly CompraEntregada[],
  declaradoKgPorMes: number | null,
  ahora: Date,
  { minOrders, staleDays }: ParametrosDeEstimacion,
): ResultadoDeEstimacion {
  const compras = compraPorDia(
    comprasEntregadas.filter(
      (c) =>
        c.deliveredAt.getTime() <= ahora.getTime() &&
        Number.isFinite(c.kg) &&
        c.kg > 0,
    ),
  );
  if (compras.length === 0) return { ok: false, reason: 'no_purchases' };
  const ultima = compras[compras.length - 1];

  const historia =
    compras.length >= minOrders ? ritmoBase(compras, minOrders) : null;
  let resultado: EstimacionDeRecompra | null = null;
  if (historia) {
    resultado = {
      ok: true,
      estimatedAt: proyectarAgotamiento(
        ultima.deliveredAt,
        ultima.kg,
        historia.base,
      ),
      source: RepurchaseEstimateSource.HISTORY,
      kgPerDay: historia.base,
      ordersUsed: historia.intervalos + 1,
      lastDeliveredAt: ultima.deliveredAt,
      lastKg: ultima.kg,
    };
  } else if (declaradoKgPorMes !== null && declaradoKgPorMes > 0) {
    resultado = {
      ok: true,
      estimatedAt: estimarProximaRecompra(
        ultima.deliveredAt,
        ultima.kg,
        declaradoKgPorMes,
      ),
      source: RepurchaseEstimateSource.DECLARED,
      kgPerDay: declaradoKgPorMes / DIAS_POR_MES,
      ordersUsed: compras.length,
      lastDeliveredAt: ultima.deliveredAt,
      lastKg: ultima.kg,
    };
  }
  if (!resultado) {
    return {
      ok: false,
      reason:
        compras.length >= minOrders
          ? 'irregular_history'
          : 'insufficient_history',
    };
  }
  const limite = ahora.getTime() - staleDays * MS_POR_DIA;
  if (resultado.estimatedAt.getTime() < limite) {
    return { ok: false, reason: 'stale' };
  }
  return resultado;
}

/**
 * Día de aviso: el cliente entra a la ventana de invitación cuando su gas se
 * acaba dentro de `avisoDias`.
 */
export function dentroDeLaVentana(
  estimatedAt: Date,
  avisoDias: number,
  ahora: Date,
): boolean {
  return estimatedAt.getTime() <= ahora.getTime() + avisoDias * MS_POR_DIA;
}

/** Días (con decimales) que faltan para la fecha; negativo si ya pasó. */
export function diasHasta(fecha: Date, ahora: Date): number {
  return (fecha.getTime() - ahora.getTime()) / MS_POR_DIA;
}
