/**
 * Valor de `Content-Disposition: attachment` con el nombre original: una
 * versión ASCII para clientes viejos y la UTF-8 de la RFC 5987 para el resto.
 * `encodeURIComponent` deja pasar `' ( ) *`, que la RFC no admite en
 * `value-chars`: se codifican a mano.
 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const utf8 = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
