import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';

/**
 * Cabeceras de seguridad (helmet) para toda la API.
 *
 * - La interfaz de Swagger (`/docs`) lleva scripts y estilos en línea: ahí va
 *   helmet sin la política de contenido (el resto de sus cabeceras sí).
 * - `/api/health` fija su propia `Content-Security-Policy` con nonce al
 *   responder: como se escribe después, pisa la de helmet y no al revés.
 * - Socket.IO y el panel (otro origen) consumen la API por CORS: la política de
 *   recursos de origen cruzado va en `cross-origin` para no bloquear imágenes
 *   ni descargas, y no se exige aislamiento de origen (`COEP`).
 */
export function montarCabecerasDeSeguridad(app: INestApplication): void {
  const base = {
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  } as const;
  const conPolitica = helmet(base);
  const sinPolitica = helmet({ ...base, contentSecurityPolicy: false });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const esDocumentacion = /^\/docs(-json|-yaml)?(\/|$)/.test(req.path);
    (esDocumentacion ? sinPolitica : conPolitica)(req, res, next);
  });
}
