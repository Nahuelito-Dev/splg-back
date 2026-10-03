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
import { S3StorageAdapter } from './s3-storage.adapter';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

/**
 * El cliente de S3 se mockea a nivel de `S3Client.prototype.send`: no hay
 * credenciales reales en este entorno (`STORAGE_S3_*` sin valores, ver
 * `.env.example`), así que la única forma de probar el adapter es simulando
 * las respuestas del SDK.
 */
describe('S3StorageAdapter', () => {
  let adapter: S3StorageAdapter;
  let send: jest.SpiedFunction<typeof S3Client.prototype.send>;

  const config = {
    getOrThrow: jest.fn((key: string) => {
      const valores: Record<string, string> = {
        STORAGE_S3_BUCKET: 'splg-fleet-docs',
        STORAGE_S3_REGION: 'sa-east-1',
        STORAGE_S3_ACCESS_KEY_ID: 'AKIA-test',
        STORAGE_S3_SECRET_ACCESS_KEY: 'secret-test',
      };
      return valores[key];
    }),
    get: jest.fn((_key: string, def: number) => def),
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

    const url = await adapter.getDownloadUrl('fleet/doc.pdf');

    expect(url).toBe('https://s3.example.com/firmada');
    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.any(S3Client),
      expect.any(GetObjectCommand),
      { expiresIn: 300 },
    );
  });

  it('con fileName, la URL firmada lleva ResponseContentDisposition', async () => {
    (getSignedUrl as jest.Mock).mockResolvedValue('https://s3.example.com/x');
    await adapter.getDownloadUrl('fleet/doc.pdf', { fileName: "o'brien.pdf" });
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
});
