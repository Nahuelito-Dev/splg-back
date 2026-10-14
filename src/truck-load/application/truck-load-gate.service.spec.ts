import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { TruckLoadStatus } from '../domain/truck-load.enums';
import { StockControlSettingsService } from './stock-control-settings.service';
import {
  MENSAJE_ABRIR_CARGA,
  MENSAJE_SIN_CARGA,
  MENSAJE_SIN_CARGA_DEL_CHOFER,
  TruckLoadGateService,
} from './truck-load-gate.service';

interface Fila {
  user_id: string;
  delivery_id: string;
  number: number | null;
  status: TruckLoadStatus | null;
  car_id: string | null;
  en_uso: string | null;
}
const fila = (over: Partial<Fila> = {}): Fila => ({
  user_id: 'u1',
  delivery_id: 'd1',
  number: null,
  status: null,
  car_id: null,
  en_uso: 'car-1',
  ...over,
});
const enRuta = (over: Partial<Fila> = {}) =>
  fila({
    number: 3,
    status: TruckLoadStatus.ON_ROUTE,
    car_id: 'car-1',
    ...over,
  });

describe('TruckLoadGateService', () => {
  let settings: { obtener: jest.Mock };
  let query: jest.Mock;
  let gate: TruckLoadGateService;

  beforeEach(() => {
    settings = {
      obtener: jest.fn().mockResolvedValue({ requireOpenTruckLoad: false }),
    };
    query = jest.fn().mockResolvedValue([]);
    gate = new TruckLoadGateService(
      settings as unknown as StockControlSettingsService,
      { query } as unknown as DataSource,
    );
  });
  const exigir = () =>
    settings.obtener.mockResolvedValue({ requireOpenTruckLoad: true });
  const mensaje = async (p: Promise<void>) =>
    ((await p.catch((e: unknown) => e)) as BadRequestException).message;

  describe('aceptar', () => {
    it('por defecto (sin D5) un chofer sin carga acepta', async () => {
      query.mockResolvedValue([fila()]);
      await expect(
        gate.assertPuedeAceptar('dist', 'd1'),
      ).resolves.toBeUndefined();
    });

    it('con D5 y sin carga abierta: 400 con el mensaje claro', async () => {
      exigir();
      query.mockResolvedValue([fila()]);
      expect(await mensaje(gate.assertPuedeAceptar('dist', 'd1'))).toBe(
        MENSAJE_SIN_CARGA,
      );
    });

    it('con la carga en ruta acepta, exija o no', async () => {
      query.mockResolvedValue([enRuta()]);
      await expect(
        gate.assertPuedeAceptar('dist', 'd1'),
      ).resolves.toBeUndefined();
      exigir();
      await expect(
        gate.assertPuedeAceptar('dist', 'd1'),
      ).resolves.toBeUndefined();
    });

    it.each([TruckLoadStatus.LOADING, TruckLoadStatus.RETURNED])(
      'con la carga %s no acepta aunque D5 esté en false',
      async (status) => {
        query.mockResolvedValue([enRuta({ status })]);
        await expect(
          gate.assertPuedeAceptar('dist', 'd1'),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it('en ruta pero con otro vehículo en uso no acepta', async () => {
      query.mockResolvedValue([enRuta({ en_uso: 'car-2' })]);
      expect(await mensaje(gate.assertPuedeAceptar('dist', 'd1'))).toMatch(
        /vehículo en uso no es el de la carga N° 3/,
      );
    });
  });

  it('la asignación manual usa su propio mensaje cuando falta la carga', async () => {
    exigir();
    query.mockResolvedValue([fila()]);
    expect(await mensaje(gate.assertPuedeAsignar('dist', 'd1'))).toBe(
      MENSAJE_SIN_CARGA_DEL_CHOFER,
    );
  });

  describe('ofertas y pool', () => {
    it('choferesQuePuedenRecibir: sólo los de carga en ruta (y los sin carga si no se exige)', async () => {
      query.mockResolvedValue([
        fila({ user_id: 'sin-carga' }),
        enRuta({ user_id: 'en-ruta' }),
        enRuta({ user_id: 'cargando', status: TruckLoadStatus.LOADING }),
        enRuta({ user_id: 'devuelta', status: TruckLoadStatus.RETURNED }),
      ]);
      const ids = ['sin-carga', 'en-ruta', 'cargando', 'devuelta'];

      expect(await gate.choferesQuePuedenRecibir('dist', ids)).toEqual(
        new Set(['sin-carga', 'en-ruta']),
      );
      exigir();
      expect(await gate.choferesQuePuedenRecibir('dist', ids)).toEqual(
        new Set(['en-ruta']),
      );
    });

    it('no consulta con la lista vacía', async () => {
      expect(await gate.choferesQuePuedenRecibir('dist', [])).toEqual(
        new Set(),
      );
      expect(query).not.toHaveBeenCalled();
    });

    it('motivoParaNoRecibir: null si puede; el aviso de la app si no', async () => {
      query.mockResolvedValue([fila()]);
      expect(await gate.motivoParaNoRecibir('dist', 'u1')).toBeNull();
      exigir();
      expect(await gate.motivoParaNoRecibir('dist', 'u1')).toBe(
        MENSAJE_ABRIR_CARGA,
      );
      query.mockResolvedValue([enRuta({ status: TruckLoadStatus.LOADING })]);
      expect(await gate.motivoParaNoRecibir('dist', 'u1')).toMatch(
        /todavía no salió/,
      );
    });
  });

  describe('lock de la carga dentro de la transacción de la aceptación', () => {
    let managerQuery: jest.Mock;
    const manager = () => ({ query: managerQuery }) as never;

    beforeEach(() => {
      managerQuery = jest.fn().mockResolvedValue([]);
    });

    it('con manager toma FOR SHARE sobre la carga abierta ANTES de leer su estado, y lee por el mismo manager', async () => {
      managerQuery.mockImplementation((sql: string) =>
        Promise.resolve(sql.includes('FOR SHARE') ? [] : [enRuta()]),
      );
      await gate.assertPuedeAceptar('dist', 'd1', manager());
      const sqls = managerQuery.mock.calls.map((c: [string]) => c[0]);
      expect(sqls).toHaveLength(2);
      expect(sqls[0]).toContain('FOR SHARE');
      expect(sqls[0]).toContain('"truck_load"');
      expect(sqls[1]).toContain('FROM "delivery"');
      // Nada fuera de la transacción: el DataSource no se toca.
      expect(query).not.toHaveBeenCalled();
    });

    it('la asignación manual toma el mismo lock', async () => {
      managerQuery.mockImplementation((sql: string) =>
        Promise.resolve(sql.includes('FOR SHARE') ? [] : [enRuta()]),
      );
      await gate.assertPuedeAsignar('dist', 'd1', manager());
      expect(
        managerQuery.mock.calls.some((c: [string]) =>
          c[0].includes('FOR SHARE'),
        ),
      ).toBe(true);
    });

    it('lo que lee bajo el lock decide: una carga devuelta no acepta', async () => {
      managerQuery.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('FOR SHARE')
            ? []
            : [enRuta({ status: TruckLoadStatus.RETURNED })],
        ),
      );
      await expect(
        gate.assertPuedeAceptar('dist', 'd1', manager()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sin manager no toma ningún lock (las lecturas de la app)', async () => {
      query.mockResolvedValue([enRuta()]);
      await gate.assertPuedeAceptar('dist', 'd1');
      expect(
        query.mock.calls.some((c: [string]) => c[0].includes('FOR SHARE')),
      ).toBe(false);
    });
  });
});
