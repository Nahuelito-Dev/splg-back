import { INestApplication, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import basicAuth from 'express-basic-auth';

/**
 * Todas las salidas de la documentación: la interfaz, el JSON y el YAML que
 * `@nestjs/swagger` publica solo junto a la interfaz. Una ruta nueva se agrega
 * acá y queda detrás de la misma credencial.
 */
export const RUTAS_DE_DOCUMENTACION = [
  '/docs',
  '/docs-json',
  '/docs-yaml',
] as const;

/** Sólo se leen `SWAGGER_USER`, `SWAGGER_PASSWORD` y `NODE_ENV`. */
type EntornoDeDocumentacion = Readonly<Record<string, string | undefined>>;

/**
 * Monta Swagger detrás de Basic Auth (`SWAGGER_USER` / `SWAGGER_PASSWORD`).
 * Falla cerrada: sin credenciales la documentación sólo se sirve abierta si
 * `NODE_ENV` es `development` o `test`; con cualquier otro valor, o sin
 * definir, no se monta. Devuelve si quedó montada.
 */
export function montarDocumentacion(
  app: INestApplication,
  env: EntornoDeDocumentacion = process.env,
  logger: Logger = new Logger('Documentacion'),
): boolean {
  const usuario = env.SWAGGER_USER;
  const clave = env.SWAGGER_PASSWORD;
  const conCredenciales = Boolean(usuario && clave);

  const entornoAbierto =
    env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  if (!conCredenciales && !entornoAbierto) {
    logger.warn(
      'SWAGGER_USER o SWAGGER_PASSWORD no configurados: la documentación no se sirve (sólo queda abierta con NODE_ENV=development o test).',
    );
    return false;
  }

  if (usuario && clave) {
    app.use(
      [...RUTAS_DE_DOCUMENTACION],
      basicAuth({ challenge: true, users: { [usuario]: clave } }),
    );
    logger.log('Swagger protegido con Basic Auth');
  } else {
    logger.warn(
      'SWAGGER_USER o SWAGGER_PASSWORD no configurados: la documentación queda abierta (NODE_ENV de desarrollo o test).',
    );
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
  return true;
}
