import {
  contentDisposition,
  Disposicion,
  disposicionSegura,
} from './content-disposition';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readS3Settings } from './s3.config';

/** Lo que hace falta para guardar un archivo. */
export interface S3ObjectInput {
  /** Clave única dentro del bucket (incluye "carpeta": p. ej. `fleet/2026/09/uuid.pdf`). */
  key: string;
  body: Buffer;
  contentType: string;
}

/** URL de descarga directa desde S3, con su vencimiento. */
export interface SignedDownload {
  url: string;
  expiresAt: Date;
}

/**
 * Cliente de Amazon S3 (o de un S3 compatible, como MinIO en desarrollo): el
 * único proveedor de archivos de la app.
 *
 * - Credenciales: si vienen `AWS_ACCESS_KEY_ID` y `AWS_SECRET_ACCESS_KEY` se
 *   usan; si no, el SDK resuelve la cadena por defecto de AWS (rol IAM del
 *   servidor, perfil).
 * - `AWS_S3_ENDPOINT` + `AWS_S3_FORCE_PATH_STYLE=true` apuntan a MinIO.
 * - Los objetos se guardan cifrados en reposo (SSE-S3, `AES256`) y el bucket
 *   es privado: la descarga NO pasa por este backend, `getSignedDownload`
 *   devuelve una URL firmada de corta duración.
 */
@Injectable()
export class S3Service {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly signedUrlTtlSeconds: number;

  constructor(config: ConfigService) {
    const settings = readS3Settings(config);
    this.bucket = settings.bucket;
    this.signedUrlTtlSeconds = settings.signedUrlTtlSeconds;
    this.client = new S3Client(settings.client);
  }

  async put({ key, body, contentType }: S3ObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  /** Contenido de un objeto del bucket (sólo para archivos chicos que el back arma: logos, sellos). */
  async get(key: string): Promise<Buffer> {
    const { Body } = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!Body)
      throw new InternalServerErrorException(
        'El objeto pedido no tiene contenido',
      );
    return Buffer.from(await Body.transformToByteArray());
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async getSignedDownload(
    key: string,
    options?: {
      fileName?: string;
      /** `inline` sólo se respeta si `contentType` es de los que se muestran sin riesgo. */
      disposition?: Disposicion;
      /** Tipo guardado del archivo; con `inline` seguro se fuerza en la respuesta. */
      contentType?: string;
    },
  ): Promise<SignedDownload> {
    const disposicion = disposicionSegura(
      options?.disposition,
      options?.contentType,
    );
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options?.fileName
        ? {
            ResponseContentDisposition: contentDisposition(
              options.fileName,
              disposicion,
            ),
          }
        : {}),
      ...(disposicion === 'inline' && options?.contentType
        ? { ResponseContentType: options.contentType.split(';')[0].trim() }
        : {}),
    });
    let expiresAt = new Date(Date.now() + this.signedUrlTtlSeconds * 1000);
    // Con credenciales temporales (rol IAM) la URL deja de servir cuando vence
    // la sesión, aunque el TTL sea mayor: `expiresAt` toma el menor de los dos.
    const { expiration } = await this.client.config.credentials();
    if (expiration && expiration < expiresAt) expiresAt = expiration;
    const url = await getSignedUrl(this.client, command, {
      expiresIn: this.signedUrlTtlSeconds,
    });
    return { url, expiresAt };
  }
}
