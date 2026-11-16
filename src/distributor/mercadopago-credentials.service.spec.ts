import {
  BadGatewayException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { CredentialsEncryptionService } from './credentials-encryption.service';
import { MercadoPagoCredentials } from './entities/mercadopago-credentials.entity';
import {
  enmascarar,
  MercadoPagoCredentialsService,
  tipoDeCuentaDe,
} from './mercadopago-credentials.service';

const TOKEN = 'APP_USR-1111111111111111-010101-abcdef0123456789abcdef-12345678';
const SISTEMA = { accessToken: 'token-sistema', webhookSecret: 'secreto-sis' };
const DTO = {
  accessToken: TOKEN,
  publicKey: 'APP_USR-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  webhookSecret: 'secreto-de-la-distribuidora',
};

/** Repositorio en memoria que respeta el filtro por columnas y la transacción. */
function repoEnMemoria(): {
  filas: MercadoPagoCredentials[];
  repo: Repository<MercadoPagoCredentials>;
  fallar: { alGuardar: Error | null };
} {
  const filas: MercadoPagoCredentials[] = [];
  const fallar: { alGuardar: Error | null } = { alGuardar: null };
  const coincide = (
    f: MercadoPagoCredentials,
    where: Partial<MercadoPagoCredentials>,
  ): boolean =>
    Object.entries(where).every(
      ([k, v]) => f[k as keyof MercadoPagoCredentials] === v,
    );
  let seq = 0;
  const repo = {
    findOne: jest.fn(({ where }: { where: Partial<MercadoPagoCredentials> }) =>
      Promise.resolve(filas.find((f) => coincide(f, where)) ?? null),
    ),
    create: jest.fn((d: Partial<MercadoPagoCredentials>) => ({
      credentialId: `cred-${++seq}`,
      ...d,
    })),
    update: jest.fn(
      (
        where: Partial<MercadoPagoCredentials>,
        cambios: Partial<MercadoPagoCredentials>,
      ) => {
        filas
          .filter((f) => coincide(f, where))
          .forEach((f) => Object.assign(f, cambios));
        return Promise.resolve();
      },
    ),
    save: jest.fn((f: MercadoPagoCredentials) => {
      if (fallar.alGuardar) return Promise.reject(fallar.alGuardar);
      if (!filas.includes(f)) filas.push(f);
      return Promise.resolve(f);
    }),
    manager: {
      transaction: (trabajo: (m: unknown) => Promise<unknown>) =>
        trabajo({ getRepository: () => repo }),
    },
  };
  return {
    filas,
    repo: repo as unknown as Repository<MercadoPagoCredentials>,
    fallar,
  };
}

describe('MercadoPagoCredentialsService', () => {
  let servicio: MercadoPagoCredentialsService;
  let filas: MercadoPagoCredentials[];
  let fallar: { alGuardar: Error | null };
  let fetchMock: jest.SpyInstance;
  const clave = randomBytes(32).toString('base64');
  let entorno: Record<string, string>;

  const armar = (conClave = true): void => {
    const memoria = repoEnMemoria();
    filas = memoria.filas;
    fallar = memoria.fallar;
    servicio = new MercadoPagoCredentialsService(
      memoria.repo,
      new CredentialsEncryptionService({
        get: () => (conClave ? clave : undefined),
      } as unknown as ConfigService),
      { get: (k: string) => entorno[k] } as unknown as ConfigService,
      (url, init) => fetch(url, init),
    );
  };

  beforeEach(() => {
    entorno = { NODE_ENV: 'development' };
    armar();
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterEach(() => jest.restoreAllMocks());

  it('cargar verifica el token contra Mercado Pago y guarda los tres valores cifrados', async () => {
    const r = await servicio.save('d1', 'u1', DTO);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.mercadopago.com/users/me',
      expect.objectContaining({
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(filas).toHaveLength(1);
    const guardado = JSON.stringify(filas[0]);
    expect(guardado).not.toContain(TOKEN);
    expect(guardado).not.toContain(DTO.webhookSecret);
    expect(r).toMatchObject({
      source: 'own',
      active: true,
      accessTokenMasked: 'APP_USR-…5678',
      webhookSecretMasked: '••••dora',
    });
  });

  it('la respuesta nunca trae los valores en claro', async () => {
    const r = await servicio.save('d1', 'u1', DTO);

    const json = JSON.stringify(r);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain(DTO.webhookSecret);
    expect(json).not.toContain(DTO.publicKey);
  });

  it('si Mercado Pago rechaza el token (401) no guarda nada', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));

    await expect(servicio.save('d1', 'u1', DTO)).rejects.toThrow(
      UnprocessableEntityException,
    );
    expect(filas).toHaveLength(0);
  });

  it('si Mercado Pago no responde no guarda nada', async () => {
    fetchMock.mockRejectedValue(new Error('sin red'));

    await expect(servicio.save('d1', 'u1', DTO)).rejects.toThrow(
      BadGatewayException,
    );
    expect(filas).toHaveLength(0);
  });

  it('si Mercado Pago contesta 500 no guarda nada', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));

    await expect(servicio.save('d1', 'u1', DTO)).rejects.toThrow(
      BadGatewayException,
    );
    expect(filas).toHaveLength(0);
  });

  it('sin clave de cifrado no se puede cargar y ni siquiera consulta a Mercado Pago', async () => {
    armar(false);

    await expect(servicio.save('d1', 'u1', DTO)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reemplazar deja la cuenta anterior desactivada (no la pisa) y activa una nueva', async () => {
    await servicio.save('d1', 'u1', DTO);

    await servicio.save('d1', 'u2', {
      ...DTO,
      webhookSecret: 'otro-secreto-1',
    });

    expect(filas).toHaveLength(2);
    expect(filas.filter((f) => f.active)).toHaveLength(1);
    expect(filas[0].active).toBe(false);
    expect(filas[1]).toMatchObject({ active: true, loadedByUserId: 'u2' });
  });

  it('un pago cobrado con la cuenta vieja sigue resolviendo a esa cuenta tras reemplazarla', async () => {
    await servicio.save('d1', 'u1', DTO);
    const vieja = filas[0].credentialId;
    await servicio.save('d1', 'u2', {
      ...DTO,
      accessToken: 'APP_USR-otra-cuenta-9999999',
    });

    const r = await servicio.resolveById(vieja, SISTEMA);

    expect(r).toMatchObject({
      accessToken: TOKEN,
      source: 'own',
      credentialId: vieja,
      distributorId: 'd1',
    });
    expect((await servicio.resolve('d1', SISTEMA)).accessToken).toBe(
      'APP_USR-otra-cuenta-9999999',
    );
  });

  it('un pago cobrado con la cuenta desactivada sigue resolviendo a esa cuenta', async () => {
    await servicio.save('d1', 'u1', DTO);
    const id = filas[0].credentialId;
    await servicio.deactivate('d1');

    expect((await servicio.resolveById(id, SISTEMA)).accessToken).toBe(TOKEN);
    expect((await servicio.resolve('d1', SISTEMA)).source).toBe('system');
  });

  it('resolveById: sin id es la cuenta del sistema y un id inexistente es un error, nunca otra cuenta', async () => {
    expect(await servicio.resolveById(null, SISTEMA)).toMatchObject({
      source: 'system',
      credentialId: null,
    });
    await expect(servicio.resolveById('no-existe', SISTEMA)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('dos cargas simultáneas que chocan en la base dan 409, no 500', async () => {
    fallar.alGuardar = Object.assign(new Error('duplicate key'), {
      code: '23505',
    });

    await expect(servicio.save('d1', 'u1', DTO)).rejects.toThrow(
      ConflictException,
    );
  });

  it('desactivar es una baja lógica: la fila queda y vuelve la cuenta del sistema', async () => {
    await servicio.save('d1', 'u1', DTO);

    const r = await servicio.deactivate('d1');

    expect(filas).toHaveLength(1);
    expect(filas[0].active).toBe(false);
    expect(r).toMatchObject({ source: 'system', active: false });
    expect(r.accessTokenMasked).toBeNull();
  });

  it('desactivar sin cuenta propia es un 404', async () => {
    await expect(servicio.deactivate('d1')).rejects.toThrow(NotFoundException);
  });

  describe('resolve', () => {
    it('sin credencial propia devuelve la cuenta del entorno', async () => {
      expect(await servicio.resolve('d1', SISTEMA)).toEqual({
        ...SISTEMA,
        source: 'system',
        credentialId: null,
        distributorId: null,
      });
    });

    it('sin distribuidora devuelve la cuenta del entorno', async () => {
      expect((await servicio.resolve(null, SISTEMA)).source).toBe('system');
    });

    it('con credencial propia activa devuelve el token y el secreto descifrados', async () => {
      await servicio.save('d1', 'u1', DTO);

      expect(await servicio.resolve('d1', SISTEMA)).toEqual({
        accessToken: TOKEN,
        webhookSecret: DTO.webhookSecret,
        source: 'own',
        credentialId: 'cred-1',
        distributorId: 'd1',
      });
    });

    it('otra distribuidora no usa las credenciales de la primera', async () => {
      await servicio.save('d1', 'u1', DTO);

      expect((await servicio.resolve('d2', SISTEMA)).source).toBe('system');
      expect((await servicio.status('d2')).source).toBe('system');
    });

    it('desactivada vuelve a la cuenta del entorno', async () => {
      await servicio.save('d1', 'u1', DTO);
      await servicio.deactivate('d1');

      expect((await servicio.resolve('d1', SISTEMA)).source).toBe('system');
    });

    it('si el servidor perdió la clave de cifrado cae a la cuenta del entorno', async () => {
      await servicio.save('d1', 'u1', DTO);
      const sinClave = new MercadoPagoCredentialsService(
        {
          findOne: () => Promise.resolve(filas[0]),
        } as unknown as Repository<MercadoPagoCredentials>,
        new CredentialsEncryptionService({
          get: () => undefined,
        } as unknown as ConfigService),
        { get: () => undefined } as unknown as ConfigService,
        (url, init) => fetch(url, init),
      );

      expect((await sinClave.resolve('d1', SISTEMA)).source).toBe('system');
      expect(await sinClave.status('d1')).toMatchObject({
        source: 'system',
        encryptionConfigured: false,
      });
    });
  });
});

describe('tipoDeCuentaDe', () => {
  it('la etiqueta test_user marca una cuenta de prueba', () => {
    expect(tipoDeCuentaDe({ nickname: 'ALGO', tags: ['test_user'] })).toBe(
      'test',
    );
  });

  it('un nickname TESTUSER… marca una cuenta de prueba', () => {
    expect(tipoDeCuentaDe({ nickname: 'TESTUSER123456', tags: [] })).toBe(
      'test',
    );
  });

  it('una cuenta sin esas marcas es real', () => {
    expect(
      tipoDeCuentaDe({ nickname: 'JENYGAS', tags: ['normal', 'mshops'] }),
    ).toBe('real');
    expect(tipoDeCuentaDe({})).toBe('real');
  });
});

describe('MercadoPagoCredentialsService: cuenta de prueba o real', () => {
  const clave = randomBytes(32).toString('base64');
  const respuesta = (cuenta: object, status = 200) =>
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(cuenta), { status })),
      );
  let avisos: jest.SpyInstance;
  let registros: jest.SpyInstance;

  const armar = (env: Record<string, string>) => {
    const memoria = repoEnMemoria();
    return {
      memoria,
      servicio: new MercadoPagoCredentialsService(
        memoria.repo,
        new CredentialsEncryptionService({
          get: () => clave,
        } as unknown as ConfigService),
        { get: (k: string) => env[k] } as unknown as ConfigService,
        (url, init) => fetch(url, init),
      ),
    };
  };

  beforeEach(() => {
    avisos = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    registros = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('el estado de una distribuidora sin cuenta propia dice si la del entorno es de prueba', async () => {
    respuesta({ nickname: 'TESTUSER1', tags: ['test_user'] });
    const { servicio } = armar({ MP_ACCESS_TOKEN: TOKEN });

    expect((await servicio.status('d1')).accountType).toBe('test');
  });

  it('el estado con cuenta propia consulta con el token propio y dice que es real', async () => {
    const f = respuesta({ nickname: 'JENYGAS', tags: ['normal'] });
    const { servicio } = armar({ MP_ACCESS_TOKEN: 'otro-token-del-entorno' });
    await servicio.save('d1', 'u1', DTO);

    const estado = await servicio.status('d1');

    expect(estado).toMatchObject({ source: 'own', accountType: 'real' });
    expect(f).toHaveBeenCalledWith(
      'https://api.mercadopago.com/users/me',
      expect.objectContaining({
        headers: { Authorization: `Bearer ${DTO.accessToken}` },
      }),
    );
  });

  it('sin token o con Mercado Pago caído el tipo es unknown y no rompe', async () => {
    const { servicio } = armar({});
    expect((await servicio.status('d1')).accountType).toBe('unknown');

    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('sin red'));
    const otro = armar({ MP_ACCESS_TOKEN: TOKEN }).servicio;
    expect((await otro.status('d1')).accountType).toBe('unknown');
  });

  it('un tipo conocido se recuerda: no se vuelve a consultar en cada estado', async () => {
    const f = respuesta({ nickname: 'X', tags: [] });
    const { servicio } = armar({
      MP_ACCESS_TOKEN: TOKEN,
      NODE_ENV: 'production',
    });

    await servicio.status('d1');
    await servicio.status('d1');

    expect(f).toHaveBeenCalledTimes(1);
  });

  it('cuenta real fuera de producción: advierte una sola vez y sin imprimir el token', async () => {
    respuesta({ nickname: 'JENYGAS', tags: [] });
    const { servicio } = armar({
      MP_ACCESS_TOKEN: TOKEN,
      NODE_ENV: 'development',
    });

    await servicio.tipoDeCuenta(TOKEN, 'la del entorno');
    await servicio.tipoDeCuenta(TOKEN, 'la del entorno');

    expect(avisos).toHaveBeenCalledTimes(1);
    const mensaje = String((avisos.mock.calls as unknown[][])[0][0]);
    expect(mensaje).toContain('REAL');
    expect(mensaje).toContain('development');
    expect(mensaje).not.toContain(TOKEN);
  });

  it('cuenta de prueba en producción también advierte', async () => {
    respuesta({ nickname: 'TESTUSER9', tags: ['test_user'] });
    const { servicio } = armar({ NODE_ENV: 'production' });

    await servicio.tipoDeCuenta(TOKEN, 'la del entorno');

    expect(String((avisos.mock.calls as unknown[][])[0][0])).toContain(
      'PRUEBA',
    );
  });

  it('cuenta de prueba fuera de producción y real en producción no advierten', async () => {
    respuesta({ nickname: 'TESTUSER9', tags: ['test_user'] });
    await armar({ NODE_ENV: 'development' }).servicio.tipoDeCuenta(TOKEN, 'x');
    respuesta({ nickname: 'JENYGAS', tags: [] });
    await armar({ NODE_ENV: 'production' }).servicio.tipoDeCuenta(TOKEN, 'x');

    expect(avisos).not.toHaveBeenCalled();
  });

  it('al arrancar consulta la cuenta del entorno y deja el tipo en el log', async () => {
    respuesta({ nickname: 'TESTUSER9', tags: ['test_user'] });
    const { servicio } = armar({ MP_ACCESS_TOKEN: TOKEN });

    servicio.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));

    expect(registros).toHaveBeenCalledWith(
      expect.stringContaining('cuenta de prueba'),
    );
  });

  it('al arrancar sin token no consulta nada', () => {
    const f = respuesta({});
    armar({}).servicio.onApplicationBootstrap();

    expect(f).not.toHaveBeenCalled();
  });
});

describe('enmascarar', () => {
  it('deja el prefijo conocido y los últimos 4', () => {
    expect(enmascarar(TOKEN)).toBe('APP_USR-…5678');
  });

  it('sin prefijo conocido sólo muestra los últimos 4', () => {
    expect(enmascarar('un-secreto-largo-9876')).toBe('••••9876');
  });

  it('un valor corto no muestra nada', () => {
    expect(enmascarar('abc')).toBe('••••');
  });
});
