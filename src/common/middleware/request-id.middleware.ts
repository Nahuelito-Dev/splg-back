import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Middleware de observabilidad: le pone un `request-id` a CADA request.
 *
 * Si el caller (front, otro servicio, un LB) ya manda `X-Request-Id`, se
 * respeta (permite correlacionar logs de punta a punta). Si no lo manda, se
 * genera uno nuevo (uuid v4 nativo de Node, sin dependencia extra).
 *
 * Se guarda en `req.requestId` (lo leen morgan, el interceptor de logging y
 * el exception filter globales) y se devuelve en la respuesta vía header
 * `X-Request-Id`, para que el cliente pueda reportarlo si algo falla.
 *
 * IMPORTANTE: nunca MUTA `req.headers['x-request-id']`. El webhook de
 * MercadoPago (`MercadoPagoWebhookController`) lee ESE mismo header crudo
 * como parte del manifiesto HMAC de la firma del webhook
 * (`WebhookSignatureValidator.validate`) — si lo pisáramos con un uuid
 * generado acá cuando MP no lo manda, la validación de firma se rompería.
 * Por eso el id "normalizado" vive SOLO en `req.requestId`, una propiedad
 * nueva, nunca en el header original.
 *
 * También deja `req.startTime` para medir la duración total del request.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.headers['x-request-id'];
  const requestId =
    typeof incoming === 'string' && incoming.trim().length > 0
      ? incoming
      : randomUUID();

  req.requestId = requestId;
  req.startTime = Date.now();

  res.setHeader('X-Request-Id', requestId);

  next();
}
