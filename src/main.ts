import {
  ValidationPipe,
  Logger,
  VersioningType,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import basicAuth from 'express-basic-auth';

import { requestIdMiddleware } from './common/middleware/request-id.middleware';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { RedisIoAdapter } from './adapters/redis-io.adapter';

import morgan from 'morgan';
import type { Request, Response } from 'express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');

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

  // Versionado por URI. La version por defecto es NEUTRAL: todas las rutas que
  // existen hoy siguen respondiendo en /api/... tal cual, sin cambiar nada para
  // el panel ni para las apps publicadas. Cuando haya que cambiar el contrato
  // de un endpoint sin romper a quien ya lo consume, se marca el nuevo con
  // @Version('2') y los dos conviven: /api/auth/login y /api/v2/auth/login.
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: VERSION_NEUTRAL,
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
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

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

  morgan.token<Request, Response>('body', (req) => {
    try {
      if (!req.body) return '{}';

      const body = { ...(req.body as Record<string, unknown>) };

      const sensitiveFields = [
        'password',
        'passwordConfirmation',
        'token',
        'access_token',
        'creditCard',
      ];

      sensitiveFields.forEach((field) => {
        if (body[field]) {
          body[field] = '******';
        }
      });

      return JSON.stringify(body);
    } catch {
      return '{}';
    }
  });

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

  const swaggerUser = process.env.SWAGGER_USER;
  const swaggerPass = process.env.SWAGGER_PASSWORD;

  if (swaggerUser && swaggerPass) {
    app.use(
      ['/docs', '/docs-json'],
      basicAuth({
        challenge: true,
        users: {
          [swaggerUser]: swaggerPass,
        },
      }),
    );
    logger.log('🔐 Swagger protegido con Basic Auth');
  } else {
    logger.warn('⚠️ SWAGGER_USER o SWAGGER_PASSWORD no configurados.');
  }

  const config = new DocumentBuilder()
    .setTitle('Gas Delivery API')
    .setDescription('API privada para sistema de delivery de gas')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      filter: true,
    },
  });

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
