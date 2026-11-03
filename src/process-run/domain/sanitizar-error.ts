const MAX_ERROR = 500;
const OCULTO = '[oculto]';

/**
 * El mensaje de error que se guarda en el historial: sin credenciales, sin
 * correos y recortado. Un error de un proveedor puede traer el token en la URL
 * o en el cuerpo, y el historial lo ve cualquier admin.
 */
export function sanitizarError(mensaje: string): string {
  return mensaje
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${OCULTO}`)
    .replace(
      /\b(token|password|passwd|secret|api[_-]?key|authorization|access_token)(["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi,
      `$1$2${OCULTO}`,
    )
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, OCULTO)
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, OCULTO)
    .trim()
    .slice(0, MAX_ERROR);
}
