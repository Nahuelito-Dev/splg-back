import Decimal from 'decimal.js';

/** Rango razonable de consumo mensual declarado, en kilos de gas por mes. */
export const CONSUMO_MINIMO_KG_MES = 5;
export const CONSUMO_MAXIMO_KG_MES = 500;

/** Un mes comercial para estimar cuánto dura una compra. */
const DIAS_POR_MES = 30;
const MS_POR_DIA = 86_400_000;

/**
 * Convierte la declaración (garrafas por mes de un tipo) a kilos por mes con
 * el peso del tipo: el dato se guarda en kilos para que siga sirviendo si el
 * cliente cambia de tipo de garrafa.
 */
export function kilosPorMes(
  pesoDeLaGarrafaKg: number,
  garrafasPorMes: number,
): number {
  return new Decimal(pesoDeLaGarrafaKg)
    .times(garrafasPorMes)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toNumber();
}

export function consumoEnRango(kgPorMes: number): boolean {
  return kgPorMes >= CONSUMO_MINIMO_KG_MES && kgPorMes <= CONSUMO_MAXIMO_KG_MES;
}

/**
 * Fecha estimada en que se acaba lo comprado: `desde` más lo que dura
 * `kgDeLaCompra` al ritmo de `kgPorMes`. Función pura, sin estado: la usan la
 * declaración (CU-143) y la corrección (CU-144).
 */
export function estimarProximaRecompra(
  desde: Date,
  kgDeLaCompra: number,
  kgPorMes: number,
): Date {
  const dias = new Decimal(kgDeLaCompra).div(kgPorMes).times(DIAS_POR_MES);
  return new Date(desde.getTime() + dias.times(MS_POR_DIA).round().toNumber());
}
