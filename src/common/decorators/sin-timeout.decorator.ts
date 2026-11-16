import { SetMetadata } from '@nestjs/common';

export const SIN_TIMEOUT_KEY = 'sinTimeout';

/**
 * Excluye el endpoint del `TimeoutInterceptor` global. Es para las descargas
 * que se transmiten por stream: cuando el timeout salta ya se enviaron los
 * encabezados y la respuesta terminaría "completa" con el archivo cortado.
 */
export const SinTimeout = () => SetMetadata(SIN_TIMEOUT_KEY, true);
