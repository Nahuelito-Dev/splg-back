import type { NextFunction, Request, Response } from 'express';
import {
  ContextoDeTraza,
  nuevoTraceId,
  traceIdDelCliente,
} from '../traza/contexto-de-traza';

/**
 * Middleware de observabilidad: le pone un `request-id` a CADA request y abre
 * con él la traza del request (`ContextoDeTraza`, `traceId = requestId`).
 *
 * Si el caller (front, otro servicio, un LB, Mercado Pago) ya manda
 * `X-Request-Id`, se usa con el prefijo `c-` (`traceIdDelCliente`) si es un id
 * razonable: de 1 a 62 caracteres con letras, dígitos, `-` o `_`. El prefijo
 * evita que un id elegido afuera coincida con uno del server. Cualquier otra
 * cosa (vacío, muy largo, con espacios o saltos de línea que ensuciarían el
 * log o la base) se reemplaza por uno nuevo (uuid v4 nativo de Node).
 *
 * Se guarda en `req.requestId` (lo leen morgan, el interceptor de logging, la
 * auditoría y el exception filter globales) y se devuelve en la respuesta vía
 * header `X-Request-Id`, para que el cliente pueda reportarlo si algo falla.
 * Todo lo que el request dispare (una corrida de proceso, un aviso a la
 * bandeja, las líneas del log) hereda el mismo `traceId`.
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
  const requestId =
    traceIdDelCliente(req.headers['x-request-id']) ?? nuevoTraceId();

  req.requestId = requestId;
  req.startTime = Date.now();

  res.setHeader('X-Request-Id', requestId);

  ContextoDeTraza.abrir({ traceId: requestId, origen: 'http', requestId }, () =>
    next(),
  );
}
