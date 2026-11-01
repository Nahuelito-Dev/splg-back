import {
  ValidationPipe,
  Logger,
  VersioningType,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { montarDocumentacion } from './common/config/documentacion';

import { requestIdMiddleware } from './common/middleware/request-id.middleware';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { origenesPermitidos } from './common/config/cors-origins';
import { RedisIoAdapter } from './adapters/redis-io.adapter';

import morgan from 'morgan';
import { cuerpoParaLog } from './common/utils/cuerpo-para-log';
import type { Request, Response } from 'express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');

  // SIGTERM/SIGINT cierran la app ordenadamente: se deja de aceptar conexiones, se
  // espera a que terminen las requests en vuelo (un webhook de pago a medio procesar)
  // y recién ahí se cierran la base y Redis. Sin esto el proceso muere de golpe.
  app.enableShutdownHooks();

  // Detras de un proxy (nginx, balanceador, Cloudflare) Express devuelve la IP
  // del proxy en req.ip, no la del usuario, salvo que se le diga cuantos saltos
  // confiar. Sin esto, el rate limiting por IP cuenta a todos juntos.
  //
  // Se configura por entorno y viene apagado: en local no hay proxy, y confiar
  // en el header sin proxy delante permitiria falsearlo para saltear el limite.
  const saltosDeProxy = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (saltosDeProxy > 0) {
    app.set('trust proxy', saltosDeProxy);
    logger.log(
      `Se confia en ${saltosDeProxy} salto(s) de proxy para resolver la IP`,
    );
  }

  app.setGlobalPrefix('api');

  // Versionado por URI. Todo lo que no declara versión es la v1 y responde en
  // /api/v1/... y también en /api/... (NEUTRAL), para no romper a quien todavía
  // llama sin número. La v1 quedó congelada el 24/10/2026: un endpoint nuevo o
  // con contrato cambiado se marca con @Version('2') y los dos conviven
  // (/api/v1/auth/login y /api/v2/auth/login).
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: [VERSION_NEUTRAL, '1'],
  });

  // Autenticación (AuthGuard) y autorización (RolesGuard) se registran como
  // guards GLOBALES vía APP_GUARD en AppModule. Siempre activos, en todos los
  // entornos: la seguridad NUNCA depende de STAGE. Las rutas abiertas se marcan
  // explícitamente con @Public().

  // Observabilidad (C4): request-id por request, PRIMERO en la cadena (antes
  // de morgan, la validación y cualquier interceptor) para que todo lo
  // demás pueda leer req.requestId / req.startTime.
  app.use(requestIdMiddleware);

  // Exception filter global: loguea toda excepción no manejada con su
  // request-id y delega en el formateo default de Nest (mismo shape de
  // respuesta de siempre). Se instancia así (no como APP_FILTER) porque
  // extiende BaseExceptionFilter y necesita el httpAdapter real.
  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(new GlobalExceptionFilter(httpAdapter));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS restringido a una allowlist desde env (CORS_ORIGINS, separada por comas).
  // Sin allowlist configurada: sin orígenes cross-site (política segura por defecto).
  const corsOrigins = origenesPermitidos();

  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Client-Source',
      'Idempotency-Key',
      // Multi-tenant: el panel super_admin y las apps eligen distribuidora con
      // este header; sin permitirlo, el preflight CORS bloquea la request.
      'X-Distributor',
      // Observabilidad: si el front propaga un request-id propio (ej. para
      // correlacionar con Sentry/logs propios), el preflight debe permitirlo.
      'X-Request-Id',
    ],
    // El request-id que genera/normaliza el backend viaja en la respuesta;
    // sin exponerlo, el JS del front no puede leerlo en un request cross-site.
    // X-Total-Count: el total de los listados paginados que devuelven un array
    // (clientes, choferes), para que el panel pagine sin adivinar.
    exposedHeaders: ['X-Request-Id', 'X-Total-Count'],
  });

  morgan.token<Request, Response>('reqId', (req) => {
    const header = req.headers['x-request-id'];
    return req.requestId ?? (typeof header === 'string' ? header : '-');
  });

  morgan.token<Request, Response>('body', (req) => cuerpoParaLog(req.body));

  morgan.token('date', () => {
    return new Date().toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  });

  app.use(
    morgan(
      ':date [:reqId] :method :url :status :res[content-length] - :response-time ms :body',
    ),
  );

  montarDocumentacion(app);

  // Adapter Redis para Socket.io: imprescindible para escalar a MÁS DE UNA
  // instancia. Sin esto, las rooms (driver_<id>, customer_<id>) viven solo en
  // la memoria del pod que aceptó el socket, y un emit en el pod A no llega al
  // cliente conectado al pod B (despacho/tracking se rompen en silencio).
  const redisIoAdapter = new RedisIoAdapter(app);
  redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`🚀 App running on port ${port}`);
}

void bootstrap();
