import { contentDisposition } from '../../common/http/servir-archivo';
import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'stream';
import {
  SignedDownload,
  StorageObjectInput,
  StorageObjectStream,
  StoragePort,
} from '../ports/storage.port';

/** Una variable vacía (`STORAGE_S3_ENDPOINT=`) cuenta como no definida. */
function opcional(config: ConfigService, name: string): string | undefined {
  const value = config.get<string>(name);
  return value ? value : undefined;
}

/**
 * Configuración del cliente S3 a partir del entorno. Sin claves explícitas NO
 * se pasa `credentials`: el SDK resuelve la cadena por defecto de AWS.
 */
export function buildS3ClientConfig(config: ConfigService): S3ClientConfig {
  const accessKeyId = opcional(config, 'STORAGE_S3_ACCESS_KEY_ID');
  const secretAccessKey = opcional(config, 'STORAGE_S3_SECRET_ACCESS_KEY');
  return {
    region: config.getOrThrow<string>('STORAGE_S3_REGION'),
    endpoint: opcional(config, 'STORAGE_S3_ENDPOINT'),
    forcePathStyle:
      String(config.get('STORAGE_S3_FORCE_PATH_STYLE', 'false')) === 'true',
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  };
}

/** Segundos de vigencia de la URL firmada de descarga. */
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

/**
 * Adapter del `StoragePort` sobre Amazon S3 (o cualquier servicio compatible,
 * como MinIO en desarrollo). Se activa con `STORAGE_DRIVER=s3`.
 *
 * - Credenciales: si vienen `STORAGE_S3_ACCESS_KEY_ID` y
 *   `STORAGE_S3_SECRET_ACCESS_KEY` se usan; si no, el SDK resuelve la cadena
 *   por defecto de AWS (rol IAM del servidor, variables `AWS_*`, perfil).
 * - `STORAGE_S3_ENDPOINT` + `STORAGE_S3_FORCE_PATH_STYLE=true` apuntan a MinIO.
 * - Los objetos se guardan cifrados en reposo (SSE-S3, `AES256`) y el bucket
 *   es privado: la descarga NO pasa por este backend, `getSignedDownload`
 *   devuelve una URL firmada de corta duración.
 */
@Injectable()
export class S3StorageAdapter extends StoragePort {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly signedUrlTtlSeconds: number;

  constructor(config: ConfigService) {
    super();
    this.bucket = config.getOrThrow<string>('STORAGE_S3_BUCKET');
    this.signedUrlTtlSeconds = Number(
      config.get<number>(
        'STORAGE_S3_SIGNED_URL_TTL_SECONDS',
        DEFAULT_SIGNED_URL_TTL_SECONDS,
      ),
    );
    this.client = new S3Client(buildS3ClientConfig(config));
  }

  async put({ key, body, contentType }: StorageObjectInput): Promise<void> {
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

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async getSignedDownload(
    key: string,
    options?: { fileName?: string },
  ): Promise<SignedDownload | null> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options?.fileName
        ? {
            ResponseContentDisposition: contentDisposition(options.fileName),
          }
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

  async getStream(key: string): Promise<StorageObjectStream> {
    const result = await this.client
      .send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      .catch((error: unknown) => {
        const name = (error as { name?: string }).name;
        if (name === 'NoSuchKey' || name === 'NotFound') {
          throw new NotFoundException(
            'El archivo no está en el almacenamiento',
          );
        }
        throw error;
      });

    if (!this.esLegible(result.Body)) {
      throw new InternalServerErrorException(
        'El objeto de S3 no se pudo leer como stream',
      );
    }

    return {
      stream: result.Body,
      contentType: result.ContentType ?? null,
      sizeBytes: result.ContentLength ?? null,
    };
  }

  /**
   * En Node, `GetObjectCommandOutput.Body` es un `Readable`; en el browser
   * sería un `ReadableStream` o un `Blob`. Este backend corre sólo en Node,
   * pero el tipo del SDK es la unión de los tres entornos.
   */
  private esLegible(body: unknown): body is Readable {
    return (
      typeof body === 'object' &&
      body !== null &&
      typeof (body as Readable).pipe === 'function'
    );
  }
}
