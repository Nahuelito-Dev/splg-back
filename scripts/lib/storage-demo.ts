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
  /** Sube un PNG a `{carpeta}/{uuid}.png` y devuelve la key. */
  subirPng(carpeta: string, png: Buffer): Promise<string>;
  /** Borra objetos; los que ya no están no cuentan como error. */
  borrar(keys: readonly string[]): Promise<void>;
}

export function crearAlmacenDemo(): AlmacenDemo | null {
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION;
  if (!bucket || !region) return null;
  const cliente = new S3Client({
    region,
    endpoint: process.env.AWS_S3_ENDPOINT || undefined,
    forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true',
  });
  return {
    async subirPng(carpeta, png) {
      const key = `${carpeta}/${randomUUID()}.png`;
      await cliente.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: png,
          ContentType: 'image/png',
          ServerSideEncryption: 'AES256',
        }),
      );
      return key;
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
