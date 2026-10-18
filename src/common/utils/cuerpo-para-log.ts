/**
 * Campos que nunca van al log de requests (morgan), en cualquier nivel del
 * cuerpo y sin distinguir mayúsculas. Incluye los datos de un tercero que se
 * cargan al indicar quién recibe un pedido (CU-128).
 */
const ENMASCARADOS = new Set([
  'password',
  'passwordconfirmation',
  'token',
  'access_token',
  'creditcard',
  'receivername',
  'receiverdocument',
  'receiverrelationship',
]);

const MASCARA = '******';

function enmascarar(valor: unknown, profundidad: number): unknown {
  if (profundidad > 5) return MASCARA;
  if (Array.isArray(valor))
    return valor.map((v) => enmascarar(v, profundidad + 1));
  if (typeof valor === 'object' && valor !== null) {
    return Object.fromEntries(
      Object.entries(valor).map(([clave, v]) => [
        clave,
        ENMASCARADOS.has(clave.toLowerCase())
          ? v
            ? MASCARA
            : v
          : enmascarar(v, profundidad + 1),
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
