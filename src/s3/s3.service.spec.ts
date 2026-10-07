import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Service } from './s3.service';
import { readS3Settings } from './s3.config';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

/**
 * Acá el cliente de S3 se mockea a nivel de `S3Client.prototype.send`: sirve
 * para los casos de error y de armado de comandos. El comportamiento real
 * (subir, URL firmada, descargar, borrar) se prueba contra MinIO en
 * `test/integration/s3.e2e-spec.ts`.
 */
describe('S3Service', () => {
  let service: S3Service;
  let send: jest.SpiedFunction<typeof S3Client.prototype.send>;

  const valores: Record<string, string> = {
    AWS_S3_BUCKET: 'splg-fleet-docs',
    AWS_REGION: 'sa-east-1',
    AWS_ACCESS_KEY_ID: 'AKIA-test',
    AWS_SECRET_ACCESS_KEY: 'secret-test',
  };
  const config = {
    getOrThrow: jest.fn((key: string) => valores[key]),
    get: jest.fn((key: string, def?: unknown) => valores[key] ?? def),
  } as unknown as ConfigService;

  const credencialesPrevias = {
    id: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
  };

  beforeAll(() => {
    process.env.AWS_ACCESS_KEY_ID = valores.AWS_ACCESS_KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = valores.AWS_SECRET_ACCESS_KEY;
  });

  afterAll(() => {
    for (const [k, v] of [
      ['AWS_ACCESS_KEY_ID', credencialesPrevias.id],
      ['AWS_SECRET_ACCESS_KEY', credencialesPrevias.secret],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    service = new S3Service(config);
    send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(() => Promise.resolve({}) as never);
    (getSignedUrl as jest.Mock).mockReset();
  });

  afterEach(() => {
    send.mockRestore();
  });

  it('sube el objeto al bucket configurado con su content-type', async () => {
    await service.put({
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
    await service.remove('fleet/doc.pdf');

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

    const signed = await service.getSignedDownload('fleet/doc.pdf');

    expect(signed.url).toBe('https://s3.example.com/firmada');
    expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now() + 290_000);
    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.any(S3Client),
      expect.any(GetObjectCommand),
      { expiresIn: 300 },
    );
  });

  it('con fileName, la URL firmada lleva ResponseContentDisposition', async () => {
    (getSignedUrl as jest.Mock).mockResolvedValue('https://s3.example.com/x');
    await service.getSignedDownload('fleet/doc.pdf', {
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
      AWS_S3_BUCKET: 'splg',
      AWS_REGION: 'sa-east-1',
    };

    it('nunca pasa `credentials` al cliente: la cadena por defecto del SDK las resuelve', () => {
      const cfg = readS3Settings(
        configDe({
          ...BASE,
          AWS_ACCESS_KEY_ID: 'AKIA-test',
          AWS_SECRET_ACCESS_KEY: 'secret-test',
        }),
      ).client;
      expect('credentials' in cfg).toBe(false);
    });

    it('las credenciales del entorno llegan con su AWS_SESSION_TOKEN (credenciales temporales)', async () => {
      const previo = { ...process.env };
      Object.assign(process.env, {
        AWS_ACCESS_KEY_ID: 'ASIA-test',
        AWS_SECRET_ACCESS_KEY: 'secret-test',
        AWS_SESSION_TOKEN: 'token-temporal',
      });
      try {
        const a = new S3Service(configDe(BASE));
        const client = (a as unknown as { client: S3Client }).client;
        await expect(client.config.credentials()).resolves.toMatchObject({
          accessKeyId: 'ASIA-test',
          sessionToken: 'token-temporal',
        });
      } finally {
        for (const k of [
          'AWS_ACCESS_KEY_ID',
          'AWS_SECRET_ACCESS_KEY',
          'AWS_SESSION_TOKEN',
        ]) {
          if (previo[k] === undefined) delete process.env[k];
          else process.env[k] = previo[k];
        }
      }
    });

    it('toma el endpoint y el direccionamiento por path de MinIO', async () => {
      const a = new S3Service(
        configDe({
          ...BASE,
          AWS_S3_ENDPOINT: 'http://localhost:9000',
          AWS_S3_FORCE_PATH_STYLE: 'true',
        }),
      );
      const client = (a as unknown as { client: S3Client }).client;
      expect(client.config.forcePathStyle).toBe(true);
      const endpoint = await client.config.endpoint?.();
      expect(endpoint?.hostname).toBe('localhost');
      expect(endpoint?.port).toBe(9000);
    });

    it('sin bucket falla al construirse, con un mensaje claro', () => {
      expect(() => new S3Service(configDe({ AWS_REGION: 'x' }))).toThrow(
        'AWS_S3_BUCKET',
      );
    });
  });

  describe('expiresAt', () => {
    it('con credenciales temporales que vencen antes que el TTL, expiresAt es la expiración de la sesión', async () => {
      const antes = new Date(Date.now() + 60_000);
      (service as unknown as { client: S3Client }).client.config.credentials =
        () =>
          Promise.resolve({
            accessKeyId: 'a',
            secretAccessKey: 'b',
            expiration: antes,
          });
      (getSignedUrl as jest.Mock).mockResolvedValue('https://s3/x');
      const signed = await service.getSignedDownload('k');
      expect(signed.expiresAt).toEqual(antes);
    });
  });
});
