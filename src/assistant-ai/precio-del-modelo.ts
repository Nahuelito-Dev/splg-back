import Decimal from 'decimal.js';

/**
 * Precios de lista de Claude Haiku 5.5, el modelo del asistente con IA, en
 * dólares por millón de tokens. Fuente: la página de precios de Anthropic,
 * tomada en DISENO-CH-BOT §6 (14/11/2026): US$ 0,10 la entrada y US$ 0,50 la
 * salida. Es el único lugar con estos números (también los usa el lector de
 * documentos para estimar el costo de una lectura con Haiku).
 */
export const PRECIO_HAIKU_5_5_USD_POR_MILLON = {
  entrada: 0.1,
  salida: 0.5,
} as const;

/**
 * Cómo se reparte un chat entre entrada y salida (§6: ~4.000 tokens de
 * entrada —instrucciones, base y conversación— y ~200 de salida): 95 % y 5 %.
 */
export const PROPORCION_DE_ENTRADA_DE_UN_CHAT = 0.95;

/** Decimales del estimado (el tope mínimo, 10.000 tokens, cuesta décimas de centavo). */
const DECIMALES = 4;

/**
 * El gasto mensual estimado en dólares si se consume todo el tope de tokens:
 * `min` con el reparto de un chat (95 % entrada, 5 % salida) y `max` si todo
 * fuera salida (el peor caso). La lectura de caché cuesta menos que la
 * entrada, así que el gasto real puede quedar por debajo de `min`. La plata
 * la calcula el back (regla de SPLG), con decimal.
 */
export function costoMensualEstimadoUsd(tokensPorMes: number): {
  min: number;
  max: number;
} {
  const millones = new Decimal(tokensPorMes).div(1_000_000);
  const entrada = new Decimal(PRECIO_HAIKU_5_5_USD_POR_MILLON.entrada);
  const salida = new Decimal(PRECIO_HAIKU_5_5_USD_POR_MILLON.salida);
  const proporcion = new Decimal(PROPORCION_DE_ENTRADA_DE_UN_CHAT);
  const precioDeUnChat = entrada
    .times(proporcion)
    .plus(salida.times(new Decimal(1).minus(proporcion)));
  return {
    min: millones.times(precioDeUnChat).toDecimalPlaces(DECIMALES).toNumber(),
    max: millones.times(salida).toDecimalPlaces(DECIMALES).toNumber(),
  };
}
