/**
 * Archivos del seed de demostración en S3 (o MinIO en desarrollo), con las
 * mismas variables `AWS_*` que usa el back. Sin bucket configurado el seed
 * sigue, pero sin fotos.
 */
import { randomUUID } from 'crypto';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface AlmacenDemo {
  /** La key de una foto nueva: `{carpeta}/{uuid}.png`. */
  nuevaKey(carpeta: string): string;
  /** Sube un PNG a una key ya reservada en `storage_orphan`. */
  subirPng(key: string, png: Buffer): Promise<void>;
  /** Borra objetos; los que ya no están no cuentan como error. */
  borrar(keys: readonly string[]): Promise<void>;
}

/**
 * Todo acceso a S3 de los seeds exige `SEED_S3=1`: el `.env` suele apuntar al
 * bucket real y un ensayo no debe tocarlo por accidente.
 */
export function s3DelSeedHabilitado(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SEED_S3 === '1';
}

export function crearAlmacenDemo(): AlmacenDemo | null {
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION;
  if (!bucket || !region) return null;
  if (!s3DelSeedHabilitado()) {
    console.warn(
      '  ! Sin SEED_S3=1 el seed no toca S3: las filas quedan sin foto.',
    );
    return null;
  }
  const cliente = new S3Client({
    region,
    endpoint: process.env.AWS_S3_ENDPOINT || undefined,
    forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true',
  });
  return {
    nuevaKey: (carpeta) => `${carpeta}/${randomUUID()}.png`,
    async subirPng(key, png) {
      await cliente.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: png,
          ContentType: 'image/png',
          ServerSideEncryption: 'AES256',
        }),
      );
    },
    async borrar(keys) {
      for (const key of keys) {
        await cliente.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        );
      }
    },
  };
}
