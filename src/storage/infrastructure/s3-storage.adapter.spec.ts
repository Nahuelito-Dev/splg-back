import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { buildS3ClientConfig, S3StorageAdapter } from './s3-storage.adapter';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

/**
 * Acá el cliente de S3 se mockea a nivel de `S3Client.prototype.send`: sirve
 * para los casos de error y de armado de comandos. El comportamiento real
 * (subir, URL firmada, descargar, borrar) se prueba contra MinIO en
 * `test/integration/storage-s3.e2e-spec.ts`.
 */
describe('S3StorageAdapter', () => {
  let adapter: S3StorageAdapter;
  let send: jest.SpiedFunction<typeof S3Client.prototype.send>;

  const valores: Record<string, string> = {
    STORAGE_S3_BUCKET: 'splg-fleet-docs',
    STORAGE_S3_REGION: 'sa-east-1',
    STORAGE_S3_ACCESS_KEY_ID: 'AKIA-test',
    STORAGE_S3_SECRET_ACCESS_KEY: 'secret-test',
  };
  const config = {
    getOrThrow: jest.fn((key: string) => valores[key]),
    get: jest.fn((key: string, def?: unknown) => valores[key] ?? def),
  } as unknown as ConfigService;

  beforeEach(() => {
    adapter = new S3StorageAdapter(config);
    send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(() => Promise.resolve({}) as never);
    (getSignedUrl as jest.Mock).mockReset();
  });

  afterEach(() => {
    send.mockRestore();
  });

  it('sube el objeto al bucket configurado con su content-type', async () => {
    await adapter.put({
      key: 'fleet/doc.pdf',
      body: Buffer.from('x'),
      contentType: 'application/pdf',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'splg-fleet-docs',
      Key: 'fleet/doc.pdf',
      ContentType: 'application/pdf',
      ServerSideEncryption: 'AES256',
    });
  });

  it('borra el objeto del bucket', async () => {
    await adapter.remove('fleet/doc.pdf');

    const command = send.mock.calls[0][0] as DeleteObjectCommand;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'splg-fleet-docs',
      Key: 'fleet/doc.pdf',
    });
  });

  it('pide una URL firmada con la expiración configurada', async () => {
    (getSignedUrl as jest.Mock).mockResolvedValue(
      'https://s3.example.com/firmada',
    );

    const signed = await adapter.getSignedDownload('fleet/doc.pdf');

    expect(signed?.url).toBe('https://s3.example.com/firmada');
    expect(signed?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 290_000);
    await expect(adapter.getDownloadUrl('fleet/doc.pdf')).resolves.toBe(
      'https://s3.example.com/firmada',
    );
    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.any(S3Client),
      expect.any(GetObjectCommand),
      { expiresIn: 300 },
    );
  });

  it('con fileName, la URL firmada lleva ResponseContentDisposition', async () => {
    (getSignedUrl as jest.Mock).mockResolvedValue('https://s3.example.com/x');
    await adapter.getSignedDownload('fleet/doc.pdf', {
      fileName: "o'brien.pdf",
    });
    const [, comando] = jest.mocked(getSignedUrl).mock.calls.at(-1) as [
      unknown,
      GetObjectCommand,
    ];
    expect(comando.input.ResponseContentDisposition).toContain(
      "filename*=UTF-8''o%27brien.pdf",
    );
  });

  it('devuelve el stream, content-type y tamaño del objeto', async () => {
    const stream = Readable.from([Buffer.from('contenido')]);
    send.mockImplementation(
      () =>
        Promise.resolve({
          Body: stream,
          ContentType: 'application/pdf',
          ContentLength: 9,
        }) as never,
    );

    const result = await adapter.getStream('fleet/doc.pdf');

    expect(result.stream).toBe(stream);
    expect(result.contentType).toBe('application/pdf');
    expect(result.sizeBytes).toBe(9);
  });

  it('si el Body no es legible como stream, falla explícito', async () => {
    send.mockImplementation(
      () => Promise.resolve({ Body: undefined }) as never,
    );

    await expect(adapter.getStream('fleet/doc.pdf')).rejects.toThrow(
      'no se pudo leer como stream',
    );
  });

  it('un objeto que no existe es 404, no 500', async () => {
    send.mockRejectedValue(
      Object.assign(new Error('x'), { name: 'NoSuchKey' }) as never,
    );
    await expect(adapter.getStream('fleet/falta.pdf')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('configuración del cliente', () => {
    function configDe(valores: Record<string, string | undefined>) {
      return {
        getOrThrow: jest.fn((key: string) => {
          const v = valores[key];
          if (!v) throw new Error(`falta ${key}`);
          return v;
        }),
        get: jest.fn((key: string, def?: unknown) => valores[key] ?? def),
      } as unknown as ConfigService;
    }

    const BASE = {
      STORAGE_S3_BUCKET: 'splg',
      STORAGE_S3_REGION: 'sa-east-1',
    };

    it('sin credenciales explícitas NO pasa `credentials` al cliente: queda la cadena de AWS', () => {
      for (const vacias of [
        {},
        { STORAGE_S3_ACCESS_KEY_ID: '', STORAGE_S3_SECRET_ACCESS_KEY: '' },
      ]) {
        const cfg = buildS3ClientConfig(configDe({ ...BASE, ...vacias }));
        expect('credentials' in cfg).toBe(false);
      }
    });

    it('con una sola de las dos claves tampoco pasa credentials', () => {
      const cfg = buildS3ClientConfig(
        configDe({ ...BASE, STORAGE_S3_ACCESS_KEY_ID: 'AKIA' }),
      );
      expect('credentials' in cfg).toBe(false);
    });

    it('con credenciales explícitas, las usa', async () => {
      const a = new S3StorageAdapter(
        configDe({
          ...BASE,
          STORAGE_S3_ACCESS_KEY_ID: 'AKIA-test',
          STORAGE_S3_SECRET_ACCESS_KEY: 'secret-test',
        }),
      );
      const client = (a as unknown as { client: S3Client }).client;
      await expect(client.config.credentials()).resolves.toMatchObject({
        accessKeyId: 'AKIA-test',
      });
    });

    it('toma el endpoint y el direccionamiento por path de MinIO', async () => {
      const a = new S3StorageAdapter(
        configDe({
          ...BASE,
          STORAGE_S3_ENDPOINT: 'http://localhost:9000',
          STORAGE_S3_FORCE_PATH_STYLE: 'true',
        }),
      );
      const client = (a as unknown as { client: S3Client }).client;
      expect(client.config.forcePathStyle).toBe(true);
      const endpoint = await client.config.endpoint?.();
      expect(endpoint?.hostname).toBe('localhost');
      expect(endpoint?.port).toBe(9000);
    });

    it('sin bucket falla al construirse, con un mensaje claro', () => {
      expect(
        () => new S3StorageAdapter(configDe({ STORAGE_S3_REGION: 'x' })),
      ).toThrow('STORAGE_S3_BUCKET');
    });
  });

  describe('expiresAt', () => {
    it('con credenciales temporales que vencen antes que el TTL, expiresAt es la expiración de la sesión', async () => {
      const antes = new Date(Date.now() + 60_000);
      (adapter as unknown as { client: S3Client }).client.config.credentials =
        () =>
          Promise.resolve({
            accessKeyId: 'a',
            secretAccessKey: 'b',
            expiration: antes,
          });
      (getSignedUrl as jest.Mock).mockResolvedValue('https://s3/x');
      const signed = await adapter.getSignedDownload('k');
      expect(signed?.expiresAt).toEqual(antes);
    });
  });
});
