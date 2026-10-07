import { ConfigService } from '@nestjs/config';
import type { S3ClientConfig } from '@aws-sdk/client-s3';

/** Segundos de vigencia de la URL firmada de descarga si no se configura otra. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

/** Lo que S3Service necesita del entorno, ya leído y con sus defaults. */
export interface S3Settings {
  bucket: string;
  signedUrlTtlSeconds: number;
  client: S3ClientConfig;
}

/** Una variable vacía (`AWS_S3_ENDPOINT=`) cuenta como no definida. */
function opcional(config: ConfigService, name: string): string | undefined {
  const value = config.get<string>(name);
  return value ? value : undefined;
}

/**
 * Configuración del cliente S3 a partir del entorno. NUNCA se pasan
 * `credentials`: el SDK resuelve la cadena por defecto de AWS, que lee
 * `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `AWS_SESSION_TOKEN` del
 * entorno (si no están, el perfil o el rol IAM del servidor). La región y el
 * bucket son obligatorios (la validación de Joi corta el arranque si faltan;
 * `getOrThrow` es la segunda red).
 */
export function readS3Settings(config: ConfigService): S3Settings {
  return {
    bucket: config.getOrThrow<string>('AWS_S3_BUCKET'),
    signedUrlTtlSeconds: Number(
      config.get<number>(
        'AWS_S3_SIGNED_URL_TTL_SECONDS',
        DEFAULT_SIGNED_URL_TTL_SECONDS,
      ),
    ),
    client: {
      region: config.getOrThrow<string>('AWS_REGION'),
      endpoint: opcional(config, 'AWS_S3_ENDPOINT'),
      forcePathStyle:
        String(config.get('AWS_S3_FORCE_PATH_STYLE', 'false')) === 'true',
    },
  };
}
