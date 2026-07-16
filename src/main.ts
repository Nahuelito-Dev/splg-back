import { ValidationPipe, Logger } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import basicAuth from 'express-basic-auth';

import { TimeoutInterceptor } from './common/interceptors/timeout.interceptors';
import { requestIdMiddleware } from './common/middleware/request-id.middleware';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { RedisIoAdapter } from './adapters/redis-io.adapter';

const morgan = require('morgan');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api');

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

  app.useGlobalInterceptors(new TimeoutInterceptor());

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
    exposedHeaders: ['X-Request-Id'],
  });

  morgan.token(
    'reqId',
    (req: any) => req.requestId ?? req.headers?.['x-request-id'] ?? '-',
  );

  morgan.token('body', (req: any) => {
    try {
      if (!req.body) return '{}';

      const body = { ...req.body };

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
    } catch (error) {
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
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`🚀 App running on port ${port}`);
}

bootstrap();
