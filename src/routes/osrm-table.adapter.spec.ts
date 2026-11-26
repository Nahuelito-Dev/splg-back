import { ConfigService } from '@nestjs/config';
import {
  OSRM_MAX_COORDENADAS,
  OsrmTableMatrixAdapter,
  PLAZO_DESPACHO_MS,
  PLAZO_TOTAL_MS,
  TIMEOUT_MS,
} from './osrm-table.adapter';
import { haversinePair } from './route-matrix';
import { PuntoDeRuta } from './polyline';
import { FetchFn } from './routes.service';

const PUNTOS: PuntoDeRuta[] = [
  { lat: -27.36, lng: -55.9 },
  { lat: -27.37, lng: -55.91 },
  { lat: -27.38, lng: -55.92 },
];

const respuesta = (cuerpo: unknown, ok = true, status = 200) =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(cuerpo) });

const config = (env: Record<string, string | undefined>) =>
  ({ get: (k: string) => env[k] }) as unknown as ConfigService;

/** Un OSRM de mentira: 60 s y 1000 m por cada unidad de diferencia de índice. */
function osrmFalso(): {
  http: jest.Mock;
  urls: string[];
} {
  const urls: string[] = [];
  const http = jest.fn((url: string) => {
    urls.push(url);
    const parte = url.split('/table/v1/driving/')[1];
    const [coordenadas, consulta] = parte.split('?');
    const puntos = coordenadas.split(';');
    const parametros = new URLSearchParams(consulta);
    const indices = (clave: string): number[] =>
      parametros.has(clave)
        ? (parametros.get(clave) as string).split(';').map(Number)
        : puntos.map((_, i) => i);
    // El «tiempo» entre dos puntos es la diferencia de su longitud, en décimas de grado.
    const lng = (i: number): number =>
      Math.round(Number(puntos[i].split(',')[0]) * 100);
    const durations = indices('sources').map((a) =>
      indices('destinations').map((b) => Math.abs(lng(a) - lng(b)) * 60),
    );
    const distances = durations.map((f) => f.map((s) => (s / 60) * 1000));
    return respuesta({ code: 'Ok', durations, distances });
  });
  return { http, urls };
}

describe('OsrmTableMatrixAdapter', () => {
  const OSRM = { OSRM_BASE_URL: 'https://osrm.splg.test/' };

  it('pide una sola tabla con todos los puntos, en orden lng,lat', async () => {
    const { http, urls } = osrmFalso();
    await new OsrmTableMatrixAdapter(config(OSRM), http as FetchFn).matrix(
      PUNTOS,
    );
    expect(urls).toEqual([
      'https://osrm.splg.test/table/v1/driving/-55.9,-27.36;-55.91,-27.37;-55.92,-27.38?annotations=duration,distance',
    ]);
  });

  it('redondea las coordenadas a seis decimales para no mandar colas de punto flotante', async () => {
    const { http, urls } = osrmFalso();
    await new OsrmTableMatrixAdapter(config(OSRM), http as FetchFn).matrix([
      { lat: -27.1 - 0.2, lng: -55.9 - 0.02 },
      { lat: -27.5, lng: -55.5 },
    ]);
    expect(urls[0]).toContain('/driving/-55.92,-27.3;-55.5,-27.5?');
  });

  it('convierte segundos a minutos y metros a kilómetros', async () => {
    const http: FetchFn = () =>
      respuesta({
        code: 'Ok',
        durations: [
          [0, 600, 1200],
          [600, 0, 90],
          [1200, 90, 0],
        ],
        distances: [
          [0, 5000, 11000],
          [5000, 0, 800],
          [11000, 800, 0],
        ],
      });
    const m = await new OsrmTableMatrixAdapter(config(OSRM), http).matrix(
      PUNTOS,
    );
    expect(m.source).toBe('osrm');
    expect(m.minutes[0][1]).toBe(10);
    expect(m.minutes[1][2]).toBeCloseTo(1.5);
    expect(m.km[0][2]).toBe(11);
    expect(m.km[1][2]).toBeCloseTo(0.8);
  });

  it('pasa una señal de cancelación al pedido', async () => {
    const { http } = osrmFalso();
    await new OsrmTableMatrixAdapter(config(OSRM), http as FetchFn).matrix(
      PUNTOS,
    );
    const llamadas = http.mock.calls as unknown as Array<[string, unknown]>;
    const init = llamadas[0][1];
    expect(init).toEqual({
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  describe('si OSRM no sirve, devuelve la línea recta y lo dice', () => {
    const casos: Array<[string, FetchFn]> = [
      ['HTTP 500', () => respuesta({}, false, 500)],
      ['code distinto de Ok', () => respuesta({ code: 'InvalidQuery' })],
      ['sin la tabla en la respuesta', () => respuesta({ code: 'Ok' })],
      ['la red caída', () => Promise.reject(new Error('ECONNREFUSED'))],
    ];

    it.each(casos)('%s', async (_nombre, http) => {
      const m = await new OsrmTableMatrixAdapter(config(OSRM), http).matrix(
        PUNTOS,
      );
      expect(m.source).toBe('haversine');
      expect(m.km[0][1]).toBeGreaterThan(0);
      expect(m.minutes[1][0]).toBe(m.minutes[0][1]);
    });

    it('sin servidor configurado en producción no llama a ningún lado', async () => {
      const http = jest.fn();
      const m = await new OsrmTableMatrixAdapter(
        config({ NODE_ENV: 'production' }),
        http as unknown as FetchFn,
      ).matrix(PUNTOS);
      expect(http).not.toHaveBeenCalled();
      expect(m.source).toBe('haversine');
    });

    it('con menos de dos puntos no hace falta preguntar', async () => {
      const http = jest.fn();
      const m = await new OsrmTableMatrixAdapter(
        config(OSRM),
        http as unknown as FetchFn,
      ).matrix([PUNTOS[0]]);
      expect(http).not.toHaveBeenCalled();
      expect(m.km).toEqual([[0]]);
    });
  });

  describe('un par sin camino', () => {
    const sinCamino: FetchFn = () =>
      respuesta({
        code: 'Ok',
        durations: [
          [0, null, 120],
          [60, 0, 60],
          [120, 60, 0],
        ],
        distances: [
          [0, null, 2000],
          [1000, 0, 1000],
          [2000, 1000, 0],
        ],
      });

    it('completa sólo ese par con la línea recta y el resto sigue siendo de OSRM', async () => {
      const m = await new OsrmTableMatrixAdapter(
        config(OSRM),
        sinCamino,
      ).matrix(PUNTOS);
      const recta = haversinePair(PUNTOS[0], PUNTOS[1]);
      expect(m.source).toBe('osrm');
      expect(m.approximatedPairs).toBe(1);
      expect(m.minutes[0][1]).toBeCloseTo(recta.minutes, 6);
      expect(m.km[0][1]).toBeCloseTo(recta.km, 6);
      // Lo que sí tenía camino viene de OSRM, no de la línea recta.
      expect(m.minutes[0][2]).toBe(2);
      expect(m.km[0][2]).toBe(2);
      expect(m.minutes[1][0]).toBe(1);
      expect(m.km[1][2]).toBe(1);
    });

    it('la línea recta de un par lleva el factor de calles de 1,3', () => {
      const recta = haversinePair(PUNTOS[0], PUNTOS[1]);
      const directa = haversinePair(PUNTOS[0], PUNTOS[1]).km / 1.3;
      expect(recta.km / directa).toBeCloseTo(1.3, 6);
    });
  });

  describe('plazos', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('un pedido que no responde se corta a los TIMEOUT_MS y la matriz cae a línea recta', async () => {
      const http: FetchFn = (_url, init) =>
        new Promise((_ok, no) => {
          init?.signal?.addEventListener('abort', () =>
            no(new Error('abortado')),
          );
        });
      const promesa = new OsrmTableMatrixAdapter(config(OSRM), http).matrix(
        PUNTOS,
      );
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(1);
      const m = await promesa;
      expect(m.source).toBe('haversine');
      expect(jest.getTimerCount()).toBe(0);
    });

    it('si el pedido responde no queda ningún temporizador vivo', async () => {
      const { http } = osrmFalso();
      const m = await new OsrmTableMatrixAdapter(
        config(OSRM),
        http as FetchFn,
      ).matrix(PUNTOS);
      expect(m.source).toBe('osrm');
      expect(jest.getTimerCount()).toBe(0);
    });

    it('con muchos bloques lentos no se suman los plazos: pasados PLAZO_TOTAL_MS corta y cae a línea recta', async () => {
      const N = OSRM_MAX_COORDENADAS + 20;
      const muchos: PuntoDeRuta[] = Array.from({ length: N }, (_, i) => ({
        lat: -27.3 - i * 0.001,
        lng: -55.9 + i * 0.01,
      }));
      const { http: bueno } = osrmFalso();
      let llamadas = 0;
      const lento: FetchFn = (url, init) => {
        llamadas++;
        return new Promise((ok) =>
          setTimeout(() => ok((bueno as FetchFn)(url, init)), 5000),
        );
      };
      const promesa = new OsrmTableMatrixAdapter(config(OSRM), lento).matrix(
        muchos,
      );
      await jest.advanceTimersByTimeAsync(PLAZO_TOTAL_MS + 20000);
      const m = await promesa;
      expect(m.source).toBe('haversine');
      // Con 9 bloques de 5 s cada uno, el plazo de 15 s alcanza para tres.
      expect(llamadas).toBe(3);
    });
  });

  it('en desarrollo, sin servidor propio, usa el OSRM público', async () => {
    const { http, urls } = osrmFalso();
    await new OsrmTableMatrixAdapter(
      config({ NODE_ENV: 'development' }),
      http as FetchFn,
    ).matrix(PUNTOS);
    expect(
      urls[0].startsWith('https://router.project-osrm.org/table/v1/driving/'),
    ).toBe(true);
  });

  describe('más puntos que los que acepta un pedido', () => {
    const N = OSRM_MAX_COORDENADAS + 20;
    const muchos: PuntoDeRuta[] = Array.from({ length: N }, (_, i) => ({
      lat: -27.3 - i * 0.001,
      lng: -55.9 + i * 0.01,
    }));

    it('los pide por bloques de origen × destino que nunca pasan el máximo y completa toda la matriz', async () => {
      const { http, urls } = osrmFalso();
      const m = await new OsrmTableMatrixAdapter(
        config(OSRM),
        http as FetchFn,
      ).matrix(muchos);
      const bloque = OSRM_MAX_COORDENADAS / 2;
      const porLado = Math.ceil(N / bloque);
      expect(urls).toHaveLength(porLado * porLado);
      for (const url of urls) {
        const usadas = url
          .split('/table/v1/driving/')[1]
          .split('?')[0]
          .split(';');
        expect(usadas.length).toBeLessThanOrEqual(OSRM_MAX_COORDENADAS);
      }
      // Los bloques de la diagonal usan los mismos puntos de origen y de destino:
      // son una tabla completa y no llevan índices; el resto sí.
      expect(urls.filter((u) => u.includes('&sources='))).toHaveLength(
        porLado * porLado - porLado,
      );
      expect(m.source).toBe('osrm');
      // El falso devuelve |Δlng| × 0,6 min; cualquier par del borde de dos bloques tiene que estar bien.
      for (const [a, b] of [
        [0, N - 1],
        [N - 1, 0],
        [49, 50],
        [50, 49],
        [N - 1, N - 1],
        [3, 117],
      ]) {
        const esperado = (Math.abs(a - b) * 1 * 60) / 60;
        expect(m.minutes[a][b]).toBeCloseTo(esperado, 6);
        expect(m.km[a][b]).toBeCloseTo(esperado, 6);
      }
    });

    it('si falla un solo bloque, toda la matriz es la de línea recta (no se mezclan fuentes)', async () => {
      let n = 0;
      const { http: bueno } = osrmFalso();
      const http: FetchFn = (url, init) =>
        ++n === 5 ? respuesta({}, false, 502) : (bueno as FetchFn)(url, init);
      const m = await new OsrmTableMatrixAdapter(config(OSRM), http).matrix(
        muchos,
      );
      expect(m.source).toBe('haversine');
      expect(m.minutes).toHaveLength(N);
    });
  });

  describe('durationsTo (N orígenes a un destino)', () => {
    const ORIGENES = PUNTOS.slice(0, 2);
    const DESTINO = PUNTOS[2];

    it('pide un solo /table con sources = orígenes y destinations = el destino', async () => {
      const { http, urls } = osrmFalso();
      const r = await new OsrmTableMatrixAdapter(
        config(OSRM),
        http as FetchFn,
      ).durationsTo(ORIGENES, DESTINO);
      expect(urls).toEqual([
        'https://osrm.splg.test/table/v1/driving/-55.9,-27.36;-55.91,-27.37;-55.92,-27.38?annotations=duration,distance&sources=0;1&destinations=2',
      ]);
      expect(r.source).toBe('osrm');
      // 2 y 1 centésimas de grado de diferencia: 2 y 1 minutos.
      expect(r.minutes[0]).toBeCloseTo(2, 6);
      expect(r.minutes[1]).toBeCloseTo(1, 6);
    });

    it('sin orígenes no llama a OSRM', async () => {
      const http = jest.fn();
      const r = await new OsrmTableMatrixAdapter(
        config(OSRM),
        http as unknown as FetchFn,
      ).durationsTo([], DESTINO);
      expect(r).toEqual({ minutes: [], source: 'haversine' });
      expect(http).not.toHaveBeenCalled();
    });

    it('si OSRM falla, todo en línea recta', async () => {
      const http: FetchFn = () => respuesta({}, false, 502);
      const r = await new OsrmTableMatrixAdapter(
        config(OSRM),
        http,
      ).durationsTo(ORIGENES, DESTINO);
      expect(r.source).toBe('haversine');
      expect(r.minutes[0]).toBeCloseTo(
        haversinePair(ORIGENES[0], DESTINO).minutes,
        6,
      );
    });

    it('sin OSRM configurado, línea recta', async () => {
      const http = jest.fn();
      const r = await new OsrmTableMatrixAdapter(
        config({}),
        http as unknown as FetchFn,
      ).durationsTo(ORIGENES, DESTINO);
      expect(r.source).toBe('haversine');
      expect(http).not.toHaveBeenCalled();
    });

    it('un origen sin camino sale de la línea recta y los demás de OSRM', async () => {
      const http: FetchFn = () =>
        respuesta({ code: 'Ok', durations: [[null], [120]] });
      const r = await new OsrmTableMatrixAdapter(
        config(OSRM),
        http,
      ).durationsTo(ORIGENES, DESTINO);
      expect(r.source).toBe('osrm');
      expect(r.minutes[0]).toBeCloseTo(
        haversinePair(ORIGENES[0], DESTINO).minutes,
        6,
      );
      expect(r.minutes[1]).toBeCloseTo(2, 6);
      // La fuente va por chofer: el de línea recta no se cuenta como OSRM.
      expect(r.sources).toEqual(['haversine', 'osrm']);
    });

    it('al despachar no espera a OSRM más que el plazo corto', async () => {
      jest.useFakeTimers();
      try {
        const http: FetchFn = (_url, init) =>
          new Promise((_ok, no) => {
            init?.signal?.addEventListener('abort', () =>
              no(new Error('abortado')),
            );
          });
        const promesa = new OsrmTableMatrixAdapter(
          config(OSRM),
          http,
        ).durationsTo(ORIGENES, DESTINO);
        await jest.advanceTimersByTimeAsync(PLAZO_DESPACHO_MS - 1);
        expect(jest.getTimerCount()).toBe(1);
        await jest.advanceTimersByTimeAsync(1);
        const r = await promesa;
        expect(r.source).toBe('haversine');
      } finally {
        jest.useRealTimers();
      }
    });

    it('una respuesta incompleta cae a la línea recta', async () => {
      const http: FetchFn = () => respuesta({ code: 'Ok', durations: [[60]] });
      const r = await new OsrmTableMatrixAdapter(
        config(OSRM),
        http,
      ).durationsTo(ORIGENES, DESTINO);
      expect(r.source).toBe('haversine');
    });

    it('con más puntos de los que admite /table, línea recta sin llamar', async () => {
      const http = jest.fn();
      const muchos = Array.from({ length: OSRM_MAX_COORDENADAS }, (_, i) => ({
        lat: -27.3 - i * 0.001,
        lng: -55.9,
      }));
      const r = await new OsrmTableMatrixAdapter(
        config(OSRM),
        http as unknown as FetchFn,
      ).durationsTo(muchos, DESTINO);
      expect(r.source).toBe('haversine');
      expect(http).not.toHaveBeenCalled();
    });
  });
});
