import { SetMetadata } from '@nestjs/common';

export const SIN_DISTRIBUIDORA_KEY = 'sinDistribuidora';

/**
 * Marca un endpoint que NO necesita resolver la distribuidora en contexto
 * (no usa `@CurrentDistributor()` ni nada que dependa del tenant). `AuthGuard`
 * ignora por completo el header `X-Distributor` para estas rutas: no lo lee,
 * no lo valida, no puede hacerlas fallar.
 *
 * Caso de uso real: `POST /auth` (verificar la sesión, el "me" de esta API).
 * El panel manda el `X-Distributor` que le quedó guardado en CADA request,
 * incluida la de verificar sesión. Si esa distribuidora ya no existe o está
 * inactiva, validar el header de más tiraba 401 por un dato que el endpoint
 * ni necesita.
 */
export const SinDistribuidora = () => SetMetadata(SIN_DISTRIBUIDORA_KEY, true);
