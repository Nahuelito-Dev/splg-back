/**
 * Reglas de las sugerencias de respuesta de la bandeja (diseño CH-BOT §3,
 * capa fija). Puras: sin base ni Nest.
 */

/** Cuántas respuestas guardadas se sugieren como mucho. */
export const TOPE_DE_SUGERENCIAS = 3;

/**
 * Parecido mínimo (`ts_rank` con los pesos por omisión de Postgres: título A,
 * texto B) para sugerir. Con menos, la coincidencia es una raíz suelta
 * perdida en el texto y la sugerencia confunde más de lo que ayuda.
 */
export const PARECIDO_MINIMO = 0.1;

/**
 * Saludos, agradecimientos y muletillas: no dicen qué necesita la persona y
 * casi toda respuesta guardada empieza con «Hola». Se comparan sin tildes, en
 * minúsculas y sin letras repetidas («holaaa», «graciass»).
 */
const CORTESIA = [
  'hola',
  'holis',
  'buenas',
  'buenos',
  'buena',
  'buen',
  'dia',
  'dias',
  'tardes',
  'noches',
  'gracias',
  'muchas',
  'muchisimas',
  'mil',
  'ok',
  'oka',
  'okey',
  'okay',
  'oki',
  'dale',
  'perfecto',
  'perfecta',
  'genial',
  'joya',
  'barbaro',
  'buenisimo',
  'bueno',
  'listo',
  'saludos',
  'saludo',
  'chau',
  'chao',
  'adios',
  'que',
  'tal',
  'como',
  'va',
  'todo',
  'bien',
  'de',
  'nada',
  'igualmente',
  'si',
];

/** Las mismas palabras, para sacarlas también de las respuestas guardadas al compararlas («Hola {{cliente.nombre}}…», «Saludo»). */
export const PALABRAS_DE_CORTESIA = CORTESIA.join(' ');

function comparable(palabra: string): string {
  return palabra
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/(\p{L})\1+/gu, '$1');
}

const CORTESIA_COMPARABLE: ReadonlySet<string> = new Set(
  CORTESIA.map(comparable),
);

/**
 * El texto con que se buscan sugerencias: el mensaje sin saludos ni
 * agradecimientos. Nulo si no queda nada («hola», «buenas tardes», «ok,
 * gracias», un emoji): no se sugiere nada.
 */
export function textoParaSugerir(mensaje: string): string | null {
  const palabras = mensaje.match(/[\p{L}\p{N}]+/gu) ?? [];
  const utiles = palabras.filter(
    (p) => !CORTESIA_COMPARABLE.has(comparable(p)),
  );
  return utiles.length > 0 ? utiles.join(' ') : null;
}
