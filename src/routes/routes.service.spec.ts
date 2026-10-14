import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RoleType } from '../common/constants/role-type.enum';
import {
  DISTANCIA_MAXIMA_DE_FROM_M,
  FetchFn,
  LIMITE_DIARIO_POR_DISTRIBUIDORA,
  LIMITE_DIARIO_POR_USUARIO,
  LIMITE_POR_MINUTO,
  RoutesService,
  distanciaEnMetros,
} from './routes.service';

const POLILINEA = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const CHOFER = { userId: 'u-chofer', role: RoleType.DELIVERY };
const CLIENTE = { userId: 'u-cliente', role: RoleType.CUSTOMER };
const ORDEN = 'o1';
const POSICION = { lat: -34.6037, lng: -58.3816 };
const DESTINO = { lat: -34.6118, lng: -58.4173 };

const respuesta = (cuerpo: unknown, ok = true, status = 200) =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(cuerpo) });

const GOOGLE_OK = {
  status: 'OK',
  routes: [
    {
      overview_polyline: { points: POLILINEA },
      legs: [
        { distance: { value: 3000 }, duration: { value: 400 } },
        { distance: { value: 2230 }, duration: { value: 380 } },
      ],
    },
  ],
};
const OSRM_OK = {
  code: 'Ok',
  routes: [{ distance: 5230.4, duration: 779.6, geometry: POLILINEA }],
};

describe('RoutesService', () => {
  let cache: Map<string, string>;
  let contadores: Map<string, number>;
  let env: Record<string, string | undefined>;
  let posicion: { lat: number; lng: number; at: string | null } | null;
  let pedidoActivoDelChofer: { orderId: string } | null;
  let redisCaido: boolean;
  let http: jest.Mock;
  let datosParaLaRuta: jest.Mock;
  let service: RoutesService;

  beforeEach(() => {
    cache = new Map();
    contadores = new Map();
    env = { GOOGLE_DIRECTIONS_API_KEY: 'clave-del-servidor' };
    posicion = { ...POSICION, at: new Date().toISOString() };
    pedidoActivoDelChofer = { orderId: ORDEN };
    redisCaido = false;
    http = jest.fn((url: string) =>
      url.includes('googleapis') ? respuesta(GOOGLE_OK) : respuesta(OSRM_OK),
    );
    const caido = () => {
      if (redisCaido) return Promise.reject(new Error('ECONNREFUSED'));
      return null;
    };
    const redis = {
      get: jest.fn(
        (k: string) => caido() ?? Promise.resolve(cache.get(k) ?? null),
      ),
      setex: jest.fn((k: string, _t: number, v: string) => {
        const falla = caido();
        if (falla) return falla;
        cache.set(k, v);
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
      getDriverLastLocation: jest.fn(
        () => caido() ?? Promise.resolve(posicion),
      ),
      getDriverActiveOrder: jest.fn(
        () => caido() ?? Promise.resolve(pedidoActivoDelChofer),
      ),
    };
    datosParaLaRuta = jest.fn().mockResolvedValue({
      distributorId: 'dist-1',
      choferUserId: 'u-chofer',
      destino: DESTINO,
    });
    const config = { get: (k: string) => env[k] };
    service = new RoutesService(
      config as never,
      redis as never,
      { datosParaLaRuta } as never,
      http as unknown as FetchFn,
    );
  });

  it('con clave del servidor usa Google; el origen es la posición del chofer y el destino el del pedido', async () => {
    const r = await service.driving(ORDEN, undefined, CHOFER);
    expect(r).toMatchObject({
      provider: 'google',
      distanceMeters: 5230,
      durationSeconds: 780,
      encodedPolyline: POLILINEA,
    });
    expect(r.points).toHaveLength(3);
    const url = (http.mock.calls[0] as [string])[0];
    expect(url).toContain('origin=-34.6037,-58.3816');
    expect(url).toContain('destination=-34.6118,-58.4173');
    expect(url).toContain('key=clave-del-servidor');
    expect(datosParaLaRuta).toHaveBeenCalledWith(
      ORDEN,
      'u-chofer',
      RoleType.DELIVERY,
    );
  });

  it('sin clave, en desarrollo usa el OSRM público (lng,lat en la URL)', async () => {
    env = { NODE_ENV: 'development' };
    const r = await service.driving(ORDEN, undefined, CHOFER);
    expect(r).toMatchObject({ provider: 'osrm', distanceMeters: 5230 });
    const url = (http.mock.calls[0] as [string])[0];
    expect(url).toContain('router.project-osrm.org');
    expect(url).toContain('-58.3816,-34.6037;-58.4173,-34.6118');
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('sin clave y fuera de desarrollo no usa el OSRM público: 503 y no consulta', async () => {
    env = { NODE_ENV: 'production' };
    await expect(
      service.driving(ORDEN, undefined, CHOFER),
    ).rejects.toMatchObject({ status: 503 });
    expect(http).not.toHaveBeenCalled();
  });

  it('OSRM_BASE_URL propio se usa también en producción', async () => {
    env = {
      NODE_ENV: 'production',
      OSRM_BASE_URL: 'http://osrm.interno:5000/',
    };
    await service.driving(ORDEN, undefined, CHOFER);
    expect((http.mock.calls[0] as [string])[0]).toContain(
      'http://osrm.interno:5000/route/v1/driving/',
    );
  });

  it('si Google responde un error, cae a OSRM (en desarrollo)', async () => {
    env = { ...env, NODE_ENV: 'development' };
    http.mockImplementation((url: string) =>
      url.includes('googleapis')
        ? respuesta({ status: 'REQUEST_DENIED' })
        : respuesta(OSRM_OK),
    );
    const r = await service.driving(ORDEN, undefined, CHOFER);
    expect(r.provider).toBe('osrm');
  });

  it('si no responde ningún proveedor, 502', async () => {
    env = { ...env, NODE_ENV: 'development' };
    http.mockImplementation(() => respuesta({}, false, 500));
    await expect(
      service.driving(ORDEN, undefined, CHOFER),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('la clave de Google no sale en la respuesta', async () => {
    const r = await service.driving(ORDEN, undefined, CHOFER);
    expect(JSON.stringify(r)).not.toContain('clave-del-servidor');
  });

  describe('origen', () => {
    it('`from` cerca de la posición del chofer se acepta', async () => {
      const cerca = `${POSICION.lat + 0.0005},${POSICION.lng}`; // ~55 m
      await service.driving(ORDEN, cerca, CHOFER);
      expect((http.mock.calls[0] as [string])[0]).toContain(
        `origin=${POSICION.lat + 0.0005},${POSICION.lng}`,
      );
    });

    it('`from` lejos de la posición del chofer: 400 y no consulta al proveedor', async () => {
      await expect(
        service.driving(ORDEN, '-34.7000,-58.5000', CHOFER),
      ).rejects.toMatchObject({ status: 400 });
      expect(http).not.toHaveBeenCalled();
    });

    it('sin posición reciente del chofer: 409 aunque mande `from`', async () => {
      posicion = {
        ...POSICION,
        at: new Date(Date.now() - 3_600_000).toISOString(),
      };
      await expect(
        service.driving(ORDEN, `${POSICION.lat},${POSICION.lng}`, CHOFER),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(http).not.toHaveBeenCalled();
    });

    it('sin posición anotada (sin hora): 409', async () => {
      posicion = { ...POSICION, at: null };
      await expect(
        service.driving(ORDEN, undefined, CHOFER),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('el cliente sólo ve la ruta si el chofer lleva ESTE pedido', async () => {
      pedidoActivoDelChofer = { orderId: 'otro' };
      await expect(
        service.driving(ORDEN, undefined, CLIENTE),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(http).not.toHaveBeenCalled();
    });

    it('el cliente con el pedido en camino obtiene la ruta', async () => {
      const r = await service.driving(ORDEN, undefined, CLIENTE);
      expect(r.provider).toBe('google');
    });

    it('distanciaEnMetros mide en metros', () => {
      expect(
        Math.round(distanciaEnMetros(POSICION, { ...POSICION, lat: -34.6027 })),
      ).toBeCloseTo(111, -1);
      expect(DISTANCIA_MAXIMA_DE_FROM_M).toBe(300);
    });
  });

  describe('caché y cupos', () => {
    it('la caché ahorra la segunda consulta al proveedor y no gasta el cupo diario', async () => {
      await service.driving(ORDEN, undefined, CHOFER);
      const r = await service.driving(ORDEN, undefined, CHOFER);
      expect(r.provider).toBe('google');
      expect(http).toHaveBeenCalledTimes(1);
      expect(contadores.get('routes:dia:usuario:u-chofer')).toBe(1);
    });

    it('otro destino no comparte caché', async () => {
      await service.driving(ORDEN, undefined, CHOFER);
      datosParaLaRuta.mockResolvedValue({
        distributorId: 'dist-1',
        choferUserId: 'u-chofer',
        destino: { lat: -34.7, lng: -58.5 },
      });
      await service.driving('o2', undefined, CHOFER);
      expect(http).toHaveBeenCalledTimes(2);
    });

    it('una caché corrupta se descarta y se recalcula', async () => {
      await service.driving(ORDEN, undefined, CHOFER);
      const claveDeRuta = [...cache.keys()].find((k) =>
        k.startsWith('routes:driving:'),
      ) as string;
      cache.set(claveDeRuta, '{roto');
      const r = await service.driving(ORDEN, undefined, CHOFER);
      expect(r.provider).toBe('google');
      expect(http).toHaveBeenCalledTimes(2);
    });

    it('pasado el cupo por minuto, 429', async () => {
      contadores.set('routes:cupo:u-chofer', LIMITE_POR_MINUTO);
      await expect(
        service.driving(ORDEN, undefined, CHOFER),
      ).rejects.toMatchObject({ status: 429 });
      expect(http).not.toHaveBeenCalled();
    });

    it('pasado el cupo diario del usuario, 429 y no llega a Google', async () => {
      contadores.set('routes:dia:usuario:u-chofer', LIMITE_DIARIO_POR_USUARIO);
      await expect(
        service.driving(ORDEN, undefined, CHOFER),
      ).rejects.toMatchObject({ status: 429 });
      expect(http).not.toHaveBeenCalled();
    });

    it('pasado el cupo diario de la distribuidora, 429 aunque el usuario esté al día', async () => {
      contadores.set(
        'routes:dia:distribuidora:dist-1',
        LIMITE_DIARIO_POR_DISTRIBUIDORA,
      );
      await expect(
        service.driving(ORDEN, undefined, CHOFER),
      ).rejects.toMatchObject({ status: 429 });
      expect(http).not.toHaveBeenCalled();
    });

    it('los topes diarios se ajustan por entorno', async () => {
      env = { ...env, ROUTES_DAILY_LIMIT_PER_USER: '1' };
      await service.driving(ORDEN, undefined, CHOFER);
      datosParaLaRuta.mockResolvedValue({
        distributorId: 'dist-1',
        choferUserId: 'u-chofer',
        destino: { lat: -34.7, lng: -58.5 },
      });
      await expect(
        service.driving('o2', undefined, CHOFER),
      ).rejects.toMatchObject({ status: 429 });
    });

    it('con Redis caído no hay 500 ni ruta desde un origen sin validar: 503 y no consulta al proveedor', async () => {
      redisCaido = true;
      const lejos = '-54.0,-68.0';
      await expect(
        service.driving(ORDEN, lejos, CHOFER),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(http).not.toHaveBeenCalled();
    });

    it('con Redis caído un cliente tampoco tiene posición del chofer: 503, no 500', async () => {
      redisCaido = true;
      await expect(
        service.driving(ORDEN, undefined, CLIENTE),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('autorización del pedido', () => {
    it('lo que rechaza el pedido (ajeno, inactivo) se propaga y no consulta nada', async () => {
      datosParaLaRuta.mockRejectedValue(new NotFoundException());
      await expect(
        service.driving(ORDEN, undefined, CHOFER),
      ).rejects.toBeInstanceOf(NotFoundException);
      datosParaLaRuta.mockRejectedValue(new ForbiddenException());
      await expect(
        service.driving(ORDEN, undefined, CHOFER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(http).not.toHaveBeenCalled();
    });
  });

  it('coordenadas fuera de rango en `from`, 400', async () => {
    await expect(
      service.driving(ORDEN, '95.0,-58.0', CHOFER),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
