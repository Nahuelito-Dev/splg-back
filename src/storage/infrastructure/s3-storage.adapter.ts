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
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'stream';
import {
  StorageObjectInput,
  StorageObjectStream,
  StoragePort,
} from '../ports/storage.port';

/** Segundos de vigencia de la URL firmada de descarga. */
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

/**
 * Adapter del `StoragePort` sobre Amazon S3. Se activa con
 * `STORAGE_DRIVER=s3`; sin credenciales configuradas todavía (ver
 * `.env.example`), pero implementado y cubierto por tests con el cliente
 * mockeado, listo para cuando se den de alta el bucket y las claves.
 *
 * La descarga NO pasa por este backend: `getDownloadUrl` devuelve una URL de
 * S3 firmada de corta duración, que el panel sigue como cualquier otra.
 */
@Injectable()
export class S3StorageAdapter extends StoragePort {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly signedUrlTtlSeconds: number;

  constructor(config: ConfigService) {
    super();
    this.bucket = config.getOrThrow<string>('STORAGE_S3_BUCKET');
    this.signedUrlTtlSeconds = config.get<number>(
      'STORAGE_S3_SIGNED_URL_TTL_SECONDS',
      DEFAULT_SIGNED_URL_TTL_SECONDS,
    );
    this.client = new S3Client({
      region: config.getOrThrow<string>('STORAGE_S3_REGION'),
      credentials: {
        accessKeyId: config.getOrThrow<string>('STORAGE_S3_ACCESS_KEY_ID'),
        secretAccessKey: config.getOrThrow<string>(
          'STORAGE_S3_SECRET_ACCESS_KEY',
        ),
      },
    });
  }

  async put({ key, body, contentType }: StorageObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async getDownloadUrl(
    key: string,
    options?: { fileName?: string },
  ): Promise<string | null> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options?.fileName
        ? {
            ResponseContentDisposition: contentDisposition(options.fileName),
          }
        : {}),
    });
    return getSignedUrl(this.client, command, {
      expiresIn: this.signedUrlTtlSeconds,
    });
  }

  async getStream(key: string): Promise<StorageObjectStream> {
    const result = await this.client
      .send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      .catch((error: unknown) => {
        if ((error as { name?: string }).name === 'NoSuchKey') {
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
