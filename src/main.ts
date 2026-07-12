import { ValidationPipe, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import basicAuth from 'express-basic-auth';

import { timeOutInterceptor } from './common/interceptors/timeout.interceptors';


const morgan = require('morgan');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api');

  // Autenticación (AuthGuard) y autorización (RolesGuard) se registran como
  // guards GLOBALES vía APP_GUARD en AppModule. Siempre activos, en todos los
  // entornos: la seguridad NUNCA depende de STAGE. Las rutas abiertas se marcan
  // explícitamente con @Public().

  app.useGlobalInterceptors(new timeOutInterceptor());

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
    ],
  });

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
      ':date :method :url :status :res[content-length] - :response-time ms :body',
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

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`🚀 App running on port ${port}`);
}

bootstrap();
