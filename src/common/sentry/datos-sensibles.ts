/**
 * Lo que no sale hacia Sentry: datos personales (DNI, CUIT, teléfono, correo,
 * domicilio) y secretos (contraseñas, tokens, cookies, la sesión de soporte,
 * credenciales de Mercado Pago y de S3).
 *
 * Se filtra por el NOMBRE del campo, en cualquier nivel: el nombre se parte en
 * palabras (`customerEmail` → `customer` + `email`, `x-support-session` →
 * `x` + `support` + `session`) y alcanza con que una sea sensible. Además, en
 * los textos libres (mensajes, valores de excepción, URLs) se tapan los
 * correos, los JWT y los `Bearer <token>`.
 *
 * No importa nada de `@nestjs/*`: lo carga `instrument.ts` antes que la app.
 */

export const FILTRADO = '[Filtered]';

/** Una palabra del nombre del campo que alcanza para taparlo. */
const PALABRAS_SENSIBLES: ReadonlySet<string> = new Set([
  'authorization',
  'auth',
  'cookie',
  'password',
  'passwd',
  'pwd',
  'contrasena',
  'token',
  'jwt',
  'bearer',
  'secret',
  'credential',
  'credentials',
  'signature',
  'dni',
  'cuit',
  'cuil',
  'phone',
  'telefono',
  'celular',
  'email',
  'mail',
  'address',
  'direccion',
  'domicilio',
]);

/** Nombres compuestos: se buscan en el nombre entero, sin separadores. */
const COMPUESTOS_SENSIBLES: readonly string[] = [
  'supportsession',
  'accesskey',
  'secretkey',
  'privatekey',
  'apikey',
  'urlquery',
  'httpquery',
  'querystring',
];

// El dominio termina en letras: `splg-server@1.0.0` (un release) no es un correo.
const CORREO = /[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi;
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const BEARER = /\bBearer\s+[\w.~+/=-]+/gi;
// El `detail` de Postgres trae los valores de la fila: `Key (cuit)=(20-…) already
// exists`, `Key (a, b)=(x, y) conflicts with existing key (a, b)=(z, w).`. Los
// valores pueden traer paréntesis sin cerrar (un rango `[1,2)`): se corta en lo
// que Postgres escribe después, no contando paréntesis.
const VALORES_DE_CLAVE =
  /(\bkey \([^()]*\)=)\(.*?\)(?=\s+(?:already exists|conflicts with|is not present|is still referenced)|\.?\s*$)/gim;
// El de un CHECK trae la fila entera: `Failing row contains (…)`.
const FILA_QUE_FALLA = /(\bFailing row contains )\(.*\)/gi;
// La consulta de una URL (`/api/v1/users?email=…`, `https://…?token=…`) no sale.
const CONSULTA_DE_URL = /((?:\bhttps?:\/\/|(?<![\w/])\/)[^\s?#]*)[?#][^\s]*/gi;

const PROFUNDIDAD_MAXIMA = 10;

function sinAcentos(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** `customerEmail` → `['customer', 'email']`; `x-support-session` → `['x', 'support', 'session']`. */
function palabrasDe(clave: string): string[] {
  return sinAcentos(clave)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length > 0);
}

/**
 * Campos que nombran algo sensible pero no lo son: `server.address` es el
 * nombre de la máquina que corre la API (el de quien llama es `client.address`).
 */
const CLAVES_PERMITIDAS: ReadonlySet<string> = new Set(['server.address']);

/** El nombre de un campo que no se manda a Sentry. */
export function esClaveSensible(clave: string): boolean {
  if (CLAVES_PERMITIDAS.has(clave)) return false;
  const palabras = palabrasDe(clave);
  const unida = palabras.join('');
  if (COMPUESTOS_SENSIBLES.some((c) => unida.includes(c))) return true;
  // También en plural: `emails`, `addresses`, `direcciones`.
  return palabras.some(
    (p) =>
      PALABRAS_SENSIBLES.has(p) ||
      (p.endsWith('s') && PALABRAS_SENSIBLES.has(p.slice(0, -1))) ||
      (p.endsWith('es') && PALABRAS_SENSIBLES.has(p.slice(0, -2))),
  );
}

/**
 * Tapa dentro de un texto libre: correos, JWT, `Bearer <token>`, los valores de
 * un `detail` de Postgres (`Key (cols)=(…)`, `Failing row contains (…)`) y la
 * consulta de las URLs.
 */
export function taparEnTexto(texto: string): string {
  return texto
    .replace(BEARER, `Bearer ${FILTRADO}`)
    .replace(JWT, FILTRADO)
    .replace(VALORES_DE_CLAVE, `$1(${FILTRADO})`)
    .replace(FILA_QUE_FALLA, `$1(${FILTRADO})`)
    .replace(CONSULTA_DE_URL, '$1')
    .replace(CORREO, FILTRADO);
}

function esObjetoPlano(valor: unknown): valor is Record<string, unknown> {
  if (typeof valor !== 'object' || valor === null) return false;
  const prototipo = Object.getPrototypeOf(valor) as unknown;
  return prototipo === Object.prototype || prototipo === null;
}

/**
 * Copia de `valor` con los campos sensibles tapados, en cualquier nivel, y los
 * textos limpios de correos y tokens. No modifica el original.
 */
export function limpiarValor(valor: unknown): unknown {
  return limpiar(valor, 0, new WeakSet<object>());
}

function limpiar(
  valor: unknown,
  profundidad: number,
  vistos: WeakSet<object>,
): unknown {
  if (typeof valor === 'string') return taparEnTexto(valor);
  if (typeof valor !== 'object' || valor === null) return valor;
  if (vistos.has(valor)) return '[Circular]';
  if (profundidad >= PROFUNDIDAD_MAXIMA) return '[Truncated]';
  vistos.add(valor);
  if (Array.isArray(valor)) {
    return valor.map((v) => limpiar(v, profundidad + 1, vistos));
  }
  if (!esObjetoPlano(valor)) return valor;
  const limpio: Record<string, unknown> = {};
  for (const [clave, v] of Object.entries(valor)) {
    limpio[clave] = esClaveSensible(clave)
      ? FILTRADO
      : limpiar(v, profundidad + 1, vistos);
  }
  return limpio;
}

/** Una URL sin la consulta ni el fragmento (y sin correos ni tokens en el camino). */
export function limpiarUrl(url: string): string {
  const corte = url.search(/[?#]/);
  return taparEnTexto(corte < 0 ? url : url.slice(0, corte));
}
