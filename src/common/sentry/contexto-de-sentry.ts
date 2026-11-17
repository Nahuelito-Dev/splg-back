import * as Sentry from '@sentry/nestjs';
import type { Scope } from '@sentry/nestjs';
import type { Request } from 'express';

/** Lo que se lee de la request para Sentry (lo deja `AuthGuard` y el middleware de request-id). */
type RequestParaSentry = Pick<
  Request,
  'headers' | 'requestId' | 'user' | 'distributorId'
>;

/** Largo máximo de un tag de Sentry. */
const LARGO_DE_TAG = 200;

function encabezado(
  request: RequestParaSentry,
  nombre: string,
): string | undefined {
  const valor = request.headers?.[nombre];
  return typeof valor === 'string' && valor.trim()
    ? valor.trim().slice(0, LARGO_DE_TAG)
    : undefined;
}

/**
 * Contexto de una request para lo que se mande a Sentry mientras dura: el
 * usuario (sólo su `user_id`: ni correo ni nombre), la empresa ya resuelta por
 * `AuthGuard` (no la que manda el cliente en `X-Distributor`), de qué cliente
 * viene (`X-Client-Source`) y el `request id` para cruzarlo con los logs.
 */
export function aplicarContextoDeRequest(
  scope: Scope,
  request: RequestParaSentry,
): void {
  const userId = request.user?.user_id;
  if (userId) scope.setUser({ id: userId });
  const empresa = request.distributorId ?? request.user?.distributor_id;
  if (empresa) scope.setTag('distributor', empresa);
  const origen = encabezado(request, 'x-client-source');
  if (origen) scope.setTag('client_source', origen);
  const requestId = request.requestId ?? encabezado(request, 'x-request-id');
  if (requestId) scope.setTag('request_id', requestId);
}

/** Aplica el contexto en el scope de aislamiento de la request en curso. */
export function contextoDeSentry(request: RequestParaSentry): void {
  aplicarContextoDeRequest(Sentry.getIsolationScope(), request);
}
