/**
 * Campos que nunca van al log de requests (morgan), en cualquier nivel del
 * cuerpo y sin distinguir mayúsculas. Se enmascara por subcadena de la clave:
 * `idToken`, `refreshToken`, `apiKey`, `newPassword` o `Authorization` salen
 * tapados sin tener que listarlos uno por uno. Incluye los datos de un tercero
 * que se cargan al indicar quién recibe un pedido (CU-128) y el detalle de la
 * documentación del personal.
 */
const FRAGMENTOS_SENSIBLES = [
  'password',
  'passwd',
  'clave',
  'contrasena',
  'contraseña',
  'token',
  'secret',
  'key',
  'authorization',
  'cookie',
  'cbu',
  'creditcard',
  'cardnumber',
  'cvv',
  'receivername',
  'receiverdocument',
  'receiverrelationship',
];

/** Claves enteras (no por subcadena): el detalle de la documentación del personal (psicofísico, ART). */
const CLAVES_EXACTAS = new Set(['details', 'pin', 'cvc', 'otp']);

function esSensible(clave: string): boolean {
  const k = clave.toLowerCase();
  return (
    CLAVES_EXACTAS.has(k) || FRAGMENTOS_SENSIBLES.some((f) => k.includes(f))
  );
}

const MASCARA = '******';

function enmascarar(valor: unknown, profundidad: number): unknown {
  if (profundidad > 5) return MASCARA;
  if (Array.isArray(valor))
    return valor.map((v) => enmascarar(v, profundidad + 1));
  if (typeof valor === 'object' && valor !== null) {
    return Object.fromEntries(
      Object.entries(valor).map(([clave, v]) => [
        clave,
        esSensible(clave) ? (v ? MASCARA : v) : enmascarar(v, profundidad + 1),
      ]),
    );
  }
  return valor;
}

/** El cuerpo de la request como texto para el log, con lo sensible enmascarado. */
export function cuerpoParaLog(cuerpo: unknown): string {
  try {
    if (!cuerpo) return '{}';
    return JSON.stringify(enmascarar(cuerpo, 0));
  } catch {
    return '{}';
  }
}

/**
 * La URL para el log, con los valores de los parámetros sensibles de la query
 * enmascarados (`?token=...`, `?apiKey=...`): la misma regla que el cuerpo.
 */
export function urlParaLog(url: string | undefined): string {
  if (!url) return '-';
  const i = url.indexOf('?');
  if (i === -1) return url;
  try {
    const params = new URLSearchParams(url.slice(i + 1));
    for (const clave of [...new Set(params.keys())]) {
      if (esSensible(clave)) params.set(clave, MASCARA);
    }
    return `${url.slice(0, i)}?${params.toString()}`;
  } catch {
    return url.slice(0, i);
  }
}
