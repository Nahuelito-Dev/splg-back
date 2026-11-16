const MAX_ERROR = 300;
const OCULTO = '[oculto]';

/**
 * El mensaje de error que se guarda en el historial: sin credenciales, sin
 * correos y recortado. Un error de un proveedor puede traer el token en la URL
 * o en el cuerpo, y el historial lo ve cualquier admin.
 */
export function sanitizarError(mensaje: string): string {
  return mensaje
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@/]+@[^\s]+/gi, (url) =>
      url.replace(/:\/\/[^\s/:@]+:[^\s@/]+@/, `://${OCULTO}@`),
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${OCULTO}`)
    .replace(/Basic\s+[A-Za-z0-9+/]+={0,2}/gi, `Basic ${OCULTO}`)
    .replace(
      /(^|[^A-Za-z0-9])(client[_-]?secret|refresh[_-]?token|access[_-]?token|pwd|pass(?:word|wd)?|token|secret|api[_-]?key|authorization|google[_-]?key)(["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi,
      `$1$2$3${OCULTO}`,
    )
    .replace(/AIza[\w-]{20,}/g, OCULTO)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, OCULTO)
    .replace(
      /\b(tel(?:ephone|[ée]fono)?|phone|mobile|celular)(["']?\s*[=:]\s*["']?)[+\d][\d\s().-]{7,}\d/gi,
      `$1$2${OCULTO}`,
    )
    .replace(/\+\d(?:[\d\s().-]*\d){7,}/g, OCULTO)
    .replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, OCULTO)
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, OCULTO)
    .trim()
    .slice(0, MAX_ERROR);
}
