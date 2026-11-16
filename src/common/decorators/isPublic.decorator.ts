import { applyDecorators, SetMetadata } from '@nestjs/common';

export const Public = () => SetMetadata('isPublic', true);

/**
 * Ruta pública que, si la request trae un token válido, igual identifica al
 * usuario y su distribuidora (`@CurrentUser()`, `@CurrentDistributor()`). Sin
 * token, o con uno inválido, se atiende como cualquier ruta pública: no
 * rechaza nunca. Para catálogos que el cliente ve sin iniciar sesión pero que
 * el panel tiene que ver acotados a su distribuidora.
 */
export const PublicIdentificable = () =>
  applyDecorators(Public(), SetMetadata('identificarSiHayToken', true));
