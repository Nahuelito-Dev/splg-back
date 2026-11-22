/**
 * Swagger del campo `gasCylinderPhotoUrl` que llevan las respuestas que nombran
 * un producto fuera del catálogo (stock, compras, conciliación).
 */
export const FOTO_DEL_PRODUCTO_API = {
  type: String,
  nullable: true,
  description:
    'URL firmada de la foto del producto (se abre sin token, vence); `null` si no tiene.',
} as const;
