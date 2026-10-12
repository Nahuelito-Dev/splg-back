/** Cómo se entrega un archivo: `attachment` lo baja, `inline` lo muestra en el navegador. */
export type Disposicion = 'inline' | 'attachment';

/**
 * Tipos que el navegador puede mostrar sin ejecutar nada. Todo lo demás
 * (HTML, SVG, XML, JS, desconocidos) se fuerza a `attachment` aunque pidan
 * `inline`: un SVG o un HTML abierto inline en el dominio del bucket corre scripts.
 */
const TIPOS_INLINE_SEGUROS: readonly string[] = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

/** `inline` sólo si lo pidieron y el tipo es seguro; si no, `attachment`. */
export function disposicionSegura(
  pedida: Disposicion | undefined,
  contentType: string | undefined,
): Disposicion {
  if (pedida !== 'inline' || !contentType) return 'attachment';
  const tipo = contentType.split(';')[0].trim().toLowerCase();
  return TIPOS_INLINE_SEGUROS.includes(tipo) ? 'inline' : 'attachment';
}

/**
 * Valor de `Content-Disposition` con el nombre original: una
 * versión ASCII para clientes viejos y la UTF-8 de la RFC 5987 para el resto.
 * `encodeURIComponent` deja pasar `' ( ) *`, que la RFC no admite en
 * `value-chars`: se codifican a mano.
 */
export function contentDisposition(
  fileName: string,
  disposicion: Disposicion = 'attachment',
): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const utf8 = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposicion}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
