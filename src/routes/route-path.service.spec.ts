import { HttpException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import {
  PuntoDeRuta,
  codificarPolilinea,
  decodificarPolilinea,
} from './polyline';
import {
  GOOGLE_PATH_FIELD_MASK,
  LIMITE_DIARIO_DE_RECORRIDOS,
  MAX_INTERMEDIOS_GOOGLE,
  RecorridoCalculado,
  RoutePathService,
  recorridoGuardado,
  TTL_DE_RECORRIDO_OSRM_SEG,
  TTL_DE_RECORRIDO_SEG,
  partirEnTramos,
  unirTramos,
} from './route-path.service';
import { FetchFn, GOOGLE_ROUTES_URL } from './routes.service';

const DIST = 'dist-1';
const CLAVE = 'clave-del-servidor';

/** `n` puntos en fila, a unos 100 m entre sí. */
const enFila = (n: number): PuntoDeRuta[] =>
  Array.from({ length: n }, (_, i) => ({
    lat: Number((-27.37 + i * 0.001).toFixed(5)),
    lng: Number((-55.9 + i * 0.001).toFixed(5)),
  }));

const respuesta = (cuerpo: unknown, ok = true, status = 200) =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(cuerpo) });

interface CuerpoGoogle {
  origin: { location: { latLng: { latitude: number; longitude: number } } };
  destination: {
    location: { latLng: { latitude: number; longitude: number } };
  };
  intermediates?: unknown[];
}

/** Google responde con la polilínea recta entre los puntos pedidos y 100 m / 10 s por tramo. */
function googleQueResponde(init?: { body?: string }) {
  const cuerpo = JSON.parse(init?.body ?? '{}') as CuerpoGoogle;
  const a = cuerpo.origin.location.latLng;
  const b = cuerpo.destination.location.latLng;
  const tramos = (cuerpo.intermediates?.length ?? 0) + 1;
  return respuesta({
    routes: [
      {
        distanceMeters: 100 * tramos,
        duration: `${10 * tramos}s`,
        polyline: {
          encodedPolyline: codificarPolilinea([
            { lat: a.latitude, lng: a.longitude },
            { lat: b.latitude, lng: b.longitude },
          ]),
        },
        legs: Array.from({ length: tramos }, () => ({
          distanceMeters: 100,
          duration: '10s',
        })),
      },
    ],
  });
}

/** OSRM: coordenadas `lng,lat;…` en la URL; 50 m / 5 s por tramo. */
function osrmQueResponde(url: string) {
  const coords = url
    .split('/route/v1/driving/')[1]
    .split('?')[0]
    .split(';')
    .map((c) => {
      const [lng, lat] = c.split(',').map(Number);
      return { lat, lng };
    });
  const tramos = coords.length - 1;
  return respuesta({
    code: 'Ok',
    routes: [
      {
        distance: 50 * tramos,
        duration: 5 * tramos,
        geometry: codificarPolilinea([coords[0], coords[coords.length - 1]]),
        legs: Array.from({ length: tramos }, () => ({
          distance: 50,
          duration: 5,
        })),
      },
    ],
  });
}

describe('partirEnTramos', () => {
  it('hasta 27 puntos (origen + 25 intermedias + destino) es un solo pedido', () => {
    expect(partirEnTramos(enFila(2))).toHaveLength(1);
    expect(partirEnTramos(enFila(MAX_INTERMEDIOS_GOOGLE + 2))).toHaveLength(1);
  });

  it('con más, parte en tramos encadenados: cada uno empieza donde terminó el anterior', () => {
    const puntos = enFila(60);
    const tramos = partirEnTramos(puntos);
    expect(tramos.map((t) => t.length)).toEqual([27, 27, 8]);
    for (const t of tramos) {
      expect(t.length - 2).toBeLessThanOrEqual(MAX_INTERMEDIOS_GOOGLE);
    }
    expect(tramos[1][0]).toBe(tramos[0][26]);
    expect(tramos[2][0]).toBe(tramos[1][26]);
    expect(tramos[2][7]).toBe(puntos[59]);
    // Ningún segmento se pierde: 59 tramos entre 60 puntos.
    expect(tramos.reduce((s, t) => s + t.length - 1, 0)).toBe(59);
  });

  it('menos de dos puntos no es un recorrido', () => {
    expect(partirEnTramos(enFila(1))).toEqual([]);
  });
});

describe('unirTramos', () => {
  const parte = (
    puntos: PuntoDeRuta[],
    legs: number[],
  ): RecorridoCalculado => ({
    provider: 'google',
    distanceMeters: legs.reduce((s, x) => s + x, 0),
    durationSeconds: legs.length,
    encodedPolyline: codificarPolilinea(puntos),
    legs: legs.map((d) => ({ distanceMeters: d, durationSeconds: 1 })),
  });

  it('suma totales, concatena tramos y no repite el punto de unión', () => {
    const [a, b, c] = enFila(3);
    const unido = unirTramos([parte([a, b], [10]), parte([b, c], [20, 30])]);
    expect(unido.distanceMeters).toBe(60);
    expect(unido.durationSeconds).toBe(3);
    expect(unido.legs.map((l) => l.distanceMeters)).toEqual([10, 20, 30]);
    expect(decodificarPolilinea(unido.encodedPolyline)).toEqual([a, b, c]);
  });

  it('un solo tramo queda tal cual', () => {
    const p = parte(enFila(2), [5]);
    expect(unirTramos([p])).toEqual(p);
  });
});

describe('recorridoGuardado', () => {
  const bueno = {
    provider: 'osrm',
    distanceMeters: 10,
    durationSeconds: 2,
    encodedPolyline: 'abc',
    legs: [
      { distanceMeters: 5, durationSeconds: 1 },
      { distanceMeters: 5, durationSeconds: 1 },
    ],
  };

  it('acepta un recorrido con la cantidad de tramos esperada', () => {
    expect(recorridoGuardado(JSON.stringify(bueno), 2)).toEqual(bueno);
  });

  it.each([
    ['JSON roto', '{roto'],
    ['null', 'null'],
    ['otra cantidad de tramos', JSON.stringify(bueno)],
    ['proveedor desconocido', JSON.stringify({ ...bueno, provider: 'x' })],
    ['sin polilínea', JSON.stringify({ ...bueno, encodedPolyline: 1 })],
    ['sin distancia', JSON.stringify({ ...bueno, distanceMeters: '10' })],
    ['sin duración', JSON.stringify({ ...bueno, durationSeconds: null })],
    ['sin tramos', JSON.stringify({ ...bueno, legs: 'x' })],
  ])('descarta %s', (caso, texto) => {
    const tramos = caso === 'otra cantidad de tramos' ? 3 : 2;
    expect(recorridoGuardado(texto, tramos)).toBeNull();
  });
});

describe('RoutePathService', () => {
  let cache: Map<string, string>;
  let ttls: Map<string, number>;
  let contadores: Map<string, number>;
  let env: Record<string, string | undefined>;
  let redisCaido: boolean;
  let http: jest.Mock<ReturnType<FetchFn>, Parameters<FetchFn>>;
  let service: RoutePathService;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    cache = new Map();
    ttls = new Map();
    contadores = new Map();
    env = { GOOGLE_DIRECTIONS_API_KEY: CLAVE, NODE_ENV: 'test' };
    redisCaido = false;
    http = jest.fn((url: string, init?: { body?: string }) =>
      url.includes('googleapis')
        ? googleQueResponde(init)
        : osrmQueResponde(url),
    );
    const caido = () =>
      redisCaido ? Promise.reject(new Error('ECONNREFUSED')) : null;
    const redis = {
      get: jest.fn(
        (k: string) => caido() ?? Promise.resolve(cache.get(k) ?? null),
      ),
      setex: jest.fn((k: string, t: number, v: string) => {
        const falla = caido();
        if (falla) return falla;
        cache.set(k, v);
        ttls.set(k, t);
        return Promise.resolve();
      }),
      del: jest.fn((k: string) => {
        cache.delete(k);
        return Promise.resolve();
      }),
      incrWithExpire: jest.fn((k: string) => {
        const falla = caido();
        if (falla) return falla;
        const n = (contadores.get(k) ?? 0) + 1;
        contadores.set(k, n);
        return Promise.resolve(n);
      }),
    };
    const config = { get: jest.fn((k: string) => env[k]) };
    service = new RoutePathService(
      config as unknown as ConfigService,
      redis as unknown as RedisService,
      http as unknown as FetchFn,
    );
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('Google: un pedido con origen, destino, intermedias, la clave en el header y la máscara con los tramos', async () => {
    const puntos = enFila(5);
    const r = await service.trazar(DIST, 'h1:a', puntos);
    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0];
    expect(url).toBe(GOOGLE_ROUTES_URL);
    expect(init?.headers).toMatchObject({
      'X-Goog-Api-Key': CLAVE,
      'X-Goog-FieldMask': GOOGLE_PATH_FIELD_MASK,
    });
    expect(url).not.toContain(CLAVE);
    const cuerpo = JSON.parse(init?.body ?? '') as CuerpoGoogle;
    expect(cuerpo.intermediates).toHaveLength(3);
    expect(cuerpo.origin.location.latLng).toEqual({
      latitude: puntos[0].lat,
      longitude: puntos[0].lng,
    });
    expect(r).toMatchObject({
      provider: 'google',
      distanceMeters: 400,
      durationSeconds: 40,
    });
    expect(r.legs).toHaveLength(4);
  });

  it('dos puntos: sin `intermediates`', async () => {
    await service.trazar(DIST, 'h1:a', enFila(2));
    const cuerpo = JSON.parse(
      http.mock.calls[0][1]?.body ?? '',
    ) as CuerpoGoogle;
    expect(cuerpo.intermediates).toBeUndefined();
  });

  it('más de 25 intermedias: parte en pedidos de a 25 y une el recorrido', async () => {
    const puntos = enFila(60);
    const r = await service.trazar(DIST, 'h1:a', puntos);
    expect(http).toHaveBeenCalledTimes(3);
    for (const [, init] of http.mock.calls) {
      const cuerpo = JSON.parse(init?.body ?? '') as CuerpoGoogle;
      expect(cuerpo.intermediates?.length ?? 0).toBeLessThanOrEqual(
        MAX_INTERMEDIOS_GOOGLE,
      );
    }
    expect(r.legs).toHaveLength(59);
    expect(r.distanceMeters).toBe(5900);
    expect(r.durationSeconds).toBe(590);
    // La polilínea unida pasa por los bordes de cada pedido, sin repetirlos.
    expect(decodificarPolilinea(r.encodedPolyline)).toEqual([
      puntos[0],
      puntos[26],
      puntos[52],
      puntos[59],
    ]);
    // Cada pedido al proveedor cuenta contra el cupo.
    expect(contadores.get(`routes:dia:recorridos:${DIST}`)).toBe(3);
  });

  it('caché: la segunda lectura con la misma clave no llama al proveedor ni gasta cupo', async () => {
    const puntos = enFila(4);
    const primera = await service.trazar(DIST, 'h1:a', puntos);
    const segunda = await service.trazar(DIST, 'h1:a', puntos);
    expect(segunda).toEqual(primera);
    expect(http).toHaveBeenCalledTimes(1);
    expect(contadores.get(`routes:dia:recorridos:${DIST}`)).toBe(1);
    // Otra firma (la hoja cambió) sí consulta.
    await service.trazar(DIST, 'h1:b', [...puntos].reverse());
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('caché: el de Google se guarda un día; el de OSRM, unos minutos (para volver a Google)', async () => {
    await service.trazar(DIST, 'h1:a', enFila(2));
    expect(ttls.get('routes:sheet-path:h1:a')).toBe(TTL_DE_RECORRIDO_SEG);
    env.GOOGLE_DIRECTIONS_API_KEY = undefined;
    await service.trazar(DIST, 'h1:b', enFila(2));
    expect(ttls.get('routes:sheet-path:h1:b')).toBe(TTL_DE_RECORRIDO_OSRM_SEG);
  });

  it('una entrada de caché rota se descarta y se recalcula', async () => {
    cache.set('routes:sheet-path:h1:a', '{roto');
    const r = await service.trazar(DIST, 'h1:a', enFila(2));
    expect(r.provider).toBe('google');
    expect(http).toHaveBeenCalledTimes(1);
    expect(JSON.parse(cache.get('routes:sheet-path:h1:a') ?? '')).toEqual(r);
  });

  it('una entrada de caché con otra cantidad de tramos se descarta y se recalcula', async () => {
    const viejo = {
      provider: 'google',
      distanceMeters: 1,
      durationSeconds: 1,
      encodedPolyline: '',
      legs: [{ distanceMeters: 1, durationSeconds: 1 }],
    };
    cache.set('routes:sheet-path:h1:a', JSON.stringify(viejo));
    const r = await service.trazar(DIST, 'h1:a', enFila(4));
    expect(http).toHaveBeenCalledTimes(1);
    expect(r.legs).toHaveLength(3);
    expect(
      (JSON.parse(cache.get('routes:sheet-path:h1:a') ?? '') as typeof r).legs,
    ).toHaveLength(3);
  });

  it('el mismo recorrido pedido dos veces a la vez se calcula una sola', async () => {
    const puntos = enFila(3);
    const [a, b] = await Promise.all([
      service.trazar(DIST, 'h1:a', puntos),
      service.trazar(DIST, 'h1:a', puntos),
    ]);
    expect(a).toEqual(b);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('Google falla: rehace TODO el recorrido con OSRM y el log no lleva la clave', async () => {
    http.mockImplementation((url: string) => {
      if (url.includes('googleapis')) {
        return respuesta(
          { error: { message: `API key ${CLAVE} not valid` } },
          false,
          403,
        );
      }
      return osrmQueResponde(url);
    });
    const r = await service.trazar(DIST, 'h1:a', enFila(30));
    expect(r.provider).toBe('osrm');
    expect(r.legs).toHaveLength(29);
    expect(r.distanceMeters).toBe(50 * 29);
    const logs = (warn.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .join('\n');
    expect(logs).toContain('se usa OSRM');
    expect(logs).not.toContain(CLAVE);
    expect(logs).toContain('***');
    // Los dos pedidos a Google sí se hicieron: cuentan; los de OSRM no.
    expect(contadores.get(`routes:dia:recorridos:${DIST}`)).toBe(2);
  });

  it('los tramos se piden a Google a la vez, no uno detrás del otro', async () => {
    const pendientes: Array<() => void> = [];
    http.mockImplementation(
      (_url: string, init?: { body?: string }) =>
        new Promise((resolver) => {
          pendientes.push(() => resolver(googleQueResponde(init)));
        }),
    );
    const trazado = service.trazar(DIST, 'h1:a', enFila(60));
    // Sin que responda ninguno, ya salieron los tres pedidos.
    for (let i = 0; i < 10 && http.mock.calls.length < 3; i++) {
      await Promise.resolve();
    }
    expect(http).toHaveBeenCalledTimes(3);
    pendientes.forEach((r) => r());
    const r = await trazado;
    expect(r.legs).toHaveLength(59);
  });

  it('Google responde con otra cantidad de tramos: no se confía y va a OSRM', async () => {
    http.mockImplementation((url: string) =>
      url.includes('googleapis')
        ? respuesta({
            routes: [
              {
                distanceMeters: 1,
                duration: '1s',
                polyline: { encodedPolyline: codificarPolilinea(enFila(2)) },
                legs: [],
              },
            ],
          })
        : osrmQueResponde(url),
    );
    expect((await service.trazar(DIST, 'h1:a', enFila(3))).provider).toBe(
      'osrm',
    );
  });

  it('Google sin rutas o sin polilínea: OSRM', async () => {
    http.mockImplementation((url: string) =>
      url.includes('googleapis')
        ? respuesta({ routes: [{ distanceMeters: 1 }] })
        : osrmQueResponde(url),
    );
    expect((await service.trazar(DIST, 'h1:a', enFila(2))).provider).toBe(
      'osrm',
    );
    http.mockImplementation((url: string) =>
      url.includes('googleapis') ? respuesta({}) : osrmQueResponde(url),
    );
    expect((await service.trazar(DIST, 'h1:b', enFila(2))).provider).toBe(
      'osrm',
    );
  });

  it('sin clave de Google usa OSRM directo', async () => {
    env.GOOGLE_DIRECTIONS_API_KEY = undefined;
    env.OSRM_BASE_URL = 'http://osrm.local/';
    const r = await service.trazar(DIST, 'h1:a', enFila(3));
    expect(r.provider).toBe('osrm');
    expect(http.mock.calls[0][0]).toMatch(
      /^http:\/\/osrm\.local\/route\/v1\/driving\/-55\.9,-27\.37;.*\?overview=full&geometries=polyline$/,
    );
    // OSRM no cuesta: no descuenta del cupo.
    expect(contadores.size).toBe(0);
  });

  it('503 ROUTE_PROVIDER_UNAVAILABLE sin clave y sin OSRM (producción)', async () => {
    env = { NODE_ENV: 'production' };
    const error = await service
      .trazar(DIST, 'h1:a', enFila(2))
      .catch((e: HttpException) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(503);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: 'ROUTE_PROVIDER_UNAVAILABLE',
    });
    expect(http).not.toHaveBeenCalled();
    // Un intento que termina en 503 no llegó a Google: no descuenta.
    expect(contadores.size).toBe(0);
  });

  it('502 ROUTE_PROVIDER_FAILED si fallan Google y OSRM; no queda nada en caché', async () => {
    http.mockImplementation(() => Promise.reject(new Error('ECONNRESET')));
    const error = await service
      .trazar(DIST, 'h1:a', enFila(2))
      .catch((e: HttpException) => e);
    expect((error as HttpException).getStatus()).toBe(502);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: 'ROUTE_PROVIDER_FAILED',
    });
    expect(cache.size).toBe(0);
  });

  it('OSRM con code distinto de Ok o con tramos de menos: 502', async () => {
    env.GOOGLE_DIRECTIONS_API_KEY = undefined;
    http.mockImplementation(() => respuesta({ code: 'NoRoute' }));
    await expect(service.trazar(DIST, 'h1:a', enFila(2))).rejects.toMatchObject(
      { status: 502 },
    );
    http.mockImplementation(() =>
      respuesta({
        code: 'Ok',
        routes: [{ geometry: codificarPolilinea(enFila(2)), legs: [] }],
      }),
    );
    await expect(service.trazar(DIST, 'h1:b', enFila(2))).rejects.toMatchObject(
      { status: 502 },
    );
  });

  it('429 ROUTE_PATH_DAILY_LIMIT al pasar el cupo diario de la distribuidora (sin llamar al proveedor)', async () => {
    contadores.set(
      `routes:dia:recorridos:${DIST}`,
      LIMITE_DIARIO_DE_RECORRIDOS,
    );
    const error = await service
      .trazar(DIST, 'h1:a', enFila(2))
      .catch((e: HttpException) => e);
    expect((error as HttpException).getStatus()).toBe(429);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: 'ROUTE_PATH_DAILY_LIMIT',
      message:
        'La distribuidora llegó al máximo de recorridos por día: probá mañana',
    });
    expect(http).not.toHaveBeenCalled();
    // Otra distribuidora no se ve afectada.
    await expect(
      service.trazar('dist-2', 'h2:a', enFila(2)),
    ).resolves.toBeTruthy();
  });

  it('el cupo se ajusta con ROUTE_SHEET_PATH_DAILY_LIMIT_PER_DISTRIBUTOR', async () => {
    env.ROUTE_SHEET_PATH_DAILY_LIMIT_PER_DISTRIBUTOR = '1';
    await service.trazar(DIST, 'h1:a', enFila(2));
    await expect(service.trazar(DIST, 'h1:b', enFila(3))).rejects.toMatchObject(
      { status: 429 },
    );
  });

  it('Redis caído: calcula igual, sin caché, y el cupo se cuenta en memoria', async () => {
    redisCaido = true;
    env.ROUTE_SHEET_PATH_DAILY_LIMIT_PER_DISTRIBUTOR = '2';
    await service.trazar(DIST, 'h1:a', enFila(2));
    await service.trazar(DIST, 'h1:a', enFila(2));
    expect(http).toHaveBeenCalledTimes(2);
    await expect(service.trazar(DIST, 'h1:a', enFila(2))).rejects.toMatchObject(
      { status: 429 },
    );
  });

  it('menos de dos puntos es un error de programación, no una consulta', async () => {
    await expect(service.trazar(DIST, 'h1:a', enFila(1))).rejects.toThrow(
      'al menos dos puntos',
    );
    expect(http).not.toHaveBeenCalled();
  });
});
