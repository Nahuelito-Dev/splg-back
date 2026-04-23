import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import basicAuth from 'express-basic-auth';
import { AuthService } from './auth/auth.service';
import { UsersService } from './users/users.service';

import { AuthGuard } from './auth/guards/jwt-auth.guard';
import { timeOutInterceptor } from './common/interceptors/timeout.interceptors';


const morgan = require('morgan');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api');

  const reflector = app.get(Reflector);
  const authService = app.get(AuthService);
  const usersService = app.get(UsersService);

  if (process.env.STAGE !== 'dev') {
    app.useGlobalGuards(new AuthGuard(reflector, authService, usersService));
  }

  app.useGlobalInterceptors(new timeOutInterceptor());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: '*',
    credentials: true,
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
