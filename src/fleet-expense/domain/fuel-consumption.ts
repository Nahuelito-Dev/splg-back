import Decimal from 'decimal.js';

/** Una carga vigente, con lo mínimo que hace falta para medir el consumo. */
export interface CargaParaConsumo {
  fuelLoadId: string;
  odometerKm: number;
  liters: number;
  totalAmount: number;
  isFullTank: boolean;
  loadedAt: Date;
}

/** Entre dos cargas de tanque lleno consecutivas. */
export interface TramoDeConsumo {
  desdeCargaId: string;
  hastaCargaId: string;
  desdeKm: number;
  hastaKm: number;
  km: number;
  /** Litros cargados después de la primera hasta la segunda inclusive. */
  liters: number;
  amount: number;
  kmPerLiter: number;
  costPerKm: number;
}

/** Cuánto se puede apartar un tramo del habitual antes de marcarse anómalo. */
export const UMBRAL_DE_ANOMALIA = 0.25;
/** Contra cuántos tramos anteriores se compara. */
export const TRAMOS_DE_REFERENCIA = 5;

function redondear(valor: Decimal, decimales: number): number {
  return valor.toDecimalPlaces(decimales, Decimal.ROUND_HALF_UP).toNumber();
}

/** Por kilometraje, y a igual kilometraje por fecha: el orden en que se recorrió el tablero. */
export function ordenarCargas<T extends CargaParaConsumo>(cargas: T[]): T[] {
  return [...cargas].sort(
    (a, b) =>
      a.odometerKm - b.odometerKm ||
      a.loadedAt.getTime() - b.loadedAt.getTime() ||
      a.fuelLoadId.localeCompare(b.fuelLoadId),
  );
}

/**
 * Método del tanque lleno: los tramos son los kilómetros entre dos cargas de
 * tanque lleno sobre todo el combustible cargado después de la primera. Lo
 * cargado antes de la primera carga llena no se puede medir y no cuenta. Un
 * tramo sin kilómetros (mismo kilometraje) se descarta.
 */
export function armarTramos(
  cargasOrdenadas: CargaParaConsumo[],
): TramoDeConsumo[] {
  const tramos: TramoDeConsumo[] = [];
  let ancla: CargaParaConsumo | null = null;
  let litros = new Decimal(0);
  let importe = new Decimal(0);

  for (const carga of cargasOrdenadas) {
    if (!ancla) {
      if (carga.isFullTank) ancla = carga;
      continue;
    }
    litros = litros.plus(carga.liters);
    importe = importe.plus(carga.totalAmount);
    if (!carga.isFullTank) continue;

    const km = carga.odometerKm - ancla.odometerKm;
    if (km > 0 && litros.gt(0)) {
      tramos.push({
        desdeCargaId: ancla.fuelLoadId,
        hastaCargaId: carga.fuelLoadId,
        desdeKm: ancla.odometerKm,
        hastaKm: carga.odometerKm,
        km,
        liters: redondear(litros, 2),
        amount: redondear(importe, 2),
        kmPerLiter: redondear(new Decimal(km).div(litros), 2),
        costPerKm: redondear(importe.div(km), 2),
      });
    }
    ancla = carga;
    litros = new Decimal(0);
    importe = new Decimal(0);
  }
  return tramos;
}

/**
 * ¿El consumo del tramo que cierra `cargaId` se aparta más de un 25 % del
 * promedio de los cinco tramos anteriores? Sólo una carga de tanque lleno
 * cierra un tramo; sin tramos anteriores no hay contra qué comparar.
 */
export function esConsumoAnomalo(
  cargasOrdenadas: CargaParaConsumo[],
  cargaId: string,
): boolean {
  const posicion = cargasOrdenadas.findIndex((c) => c.fuelLoadId === cargaId);
  if (posicion < 0) return false;
  const tramos = armarTramos(cargasOrdenadas.slice(0, posicion + 1));
  const ultimo = tramos[tramos.length - 1];
  if (!ultimo || ultimo.hastaCargaId !== cargaId) return false;

  const anteriores = tramos.slice(0, -1).slice(-TRAMOS_DE_REFERENCIA);
  if (anteriores.length === 0) return false;

  const promedio = anteriores
    .reduce((suma, t) => suma.plus(t.kmPerLiter), new Decimal(0))
    .div(anteriores.length);
  if (promedio.lte(0)) return false;
  const desvio = new Decimal(ultimo.kmPerLiter)
    .minus(promedio)
    .abs()
    .div(promedio);
  return desvio.gt(UMBRAL_DE_ANOMALIA);
}

/** Totales de un conjunto de tramos; las razones son `null` si no hay tramos. */
export function totalizarTramos(tramos: TramoDeConsumo[]): {
  km: number;
  liters: number;
  amount: number;
  kmPerLiter: number | null;
  costPerKm: number | null;
} {
  const km = tramos.reduce((s, t) => s + t.km, 0);
  const litros = tramos.reduce((s, t) => s.plus(t.liters), new Decimal(0));
  const importe = tramos.reduce((s, t) => s.plus(t.amount), new Decimal(0));
  return {
    km,
    liters: redondear(litros, 2),
    amount: redondear(importe, 2),
    kmPerLiter:
      km > 0 && litros.gt(0) ? redondear(new Decimal(km).div(litros), 2) : null,
    costPerKm: km > 0 ? redondear(importe.div(km), 2) : null,
  };
}

/** El importe tiene que coincidir con litros × precio por litro, con una tolerancia del 1 %. */
export const TOLERANCIA_DEL_IMPORTE = 0.01;
/** Los litros pueden pasar hasta un 5 % la capacidad del tanque. */
export const TOLERANCIA_DEL_TANQUE = 1.05;

/** El importe de una carga: litros × precio por litro, a 2 decimales. */
export function importeEsperado(liters: number, unitPrice: number): number {
  return new Decimal(liters).times(unitPrice).toDecimalPlaces(2).toNumber();
}

export function importeCoincide(
  liters: number,
  unitPrice: number,
  totalAmount: number,
): boolean {
  const esperado = new Decimal(liters).times(unitPrice);
  const diferencia = new Decimal(totalAmount).minus(esperado).abs();
  return diferencia.lte(esperado.times(TOLERANCIA_DEL_IMPORTE));
}

export function litrosEntranEnElTanque(
  liters: number,
  capacity: number | null,
): boolean {
  if (capacity === null) return true;
  return new Decimal(liters).lte(
    new Decimal(capacity).times(TOLERANCIA_DEL_TANQUE),
  );
}
