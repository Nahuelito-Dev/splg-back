import { DataSource } from 'typeorm';
import { CashBoxKind } from '../domain/cash.enums';
import {
  CajaNoEncontradaError,
  MovimientoInvalidoError,
} from '../domain/errors/cash.errors';
import { IncomeStatementGroupBy } from '../dto/cash-income-statement.dto';
import {
  CashIncomeStatementService,
  periodosDelRango,
} from './cash-income-statement.service';

describe('CashIncomeStatementService', () => {
  let consultas: Array<{ sql: string; params: unknown[] }>;
  let cajaExiste: boolean;
  let filas: {
    categorias: unknown[];
    periodos: unknown[];
    cajas: unknown[];
  };
  let servicio: CashIncomeStatementService;
  let runnerDeLaPrueba: { release: jest.Mock; query: jest.Mock };

  beforeEach(() => {
    consultas = [];
    cajaExiste = true;
    filas = { categorias: [], periodos: [], cajas: [] };
    const runner = {
      connect: jest.fn(() => Promise.resolve()),
      release: jest.fn(() => Promise.resolve()),
      query: jest.fn((sql: string, params: unknown[]) => {
        consultas.push({ sql: sql.replace(/\s+/g, ' '), params });
        if (sql.includes('SELECT 1 FROM "cash_box"')) {
          return Promise.resolve(cajaExiste ? [{ '?column?': 1 }] : []);
        }
        if (sql.includes('JOIN "cash_category"'))
          return Promise.resolve(filas.categorias);
        if (sql.includes('JOIN "cash_box" b'))
          return Promise.resolve(filas.cajas);
        if (sql.includes('AS count') && !sql.includes('JOIN'))
          return Promise.resolve([{ amount: '5000.50', count: 1 }]);
        if (sql.includes('date_trunc')) return Promise.resolve(filas.periodos);
        return Promise.resolve([]);
      }),
    };
    runnerDeLaPrueba = runner;
    const dataSource = {
      createQueryRunner: jest.fn(() => runner),
    } as unknown as DataSource;
    servicio = new CashIncomeStatementService(dataSource);
  });

  const lecturas = () =>
    consultas.filter((c) => c.sql.includes('FROM "cash_movement" m'));

  describe('consulta', () => {
    it('lee las cuatro vistas en una sola transacción de sólo lectura', async () => {
      await servicio.consultar('dist-1', {
        from: '2026-10-01',
        to: '2026-10-31',
      });
      const sqls = consultas.map((c) => c.sql);
      expect(sqls[0]).toBe(
        'START TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      expect(sqls[sqls.length - 1]).toBe('COMMIT');
      expect(lecturas()).toHaveLength(4);
      expect(runnerDeLaPrueba.release).toHaveBeenCalledTimes(1);
    });

    it('si falla una lectura, deshace y libera la conexión', async () => {
      runnerDeLaPrueba.query.mockImplementation((sql: string) =>
        sql.includes('date_trunc')
          ? Promise.reject(new Error('se cayó'))
          : Promise.resolve([]),
      );
      await expect(
        servicio.consultar('dist-1', { from: '2026-10-01', to: '2026-10-31' }),
      ).rejects.toThrow('se cayó');
      expect(runnerDeLaPrueba.query).toHaveBeenCalledWith('ROLLBACK');
      expect(runnerDeLaPrueba.release).toHaveBeenCalledTimes(1);
    });

    it('acota a la distribuidora y al rango de días argentinos (hasta inclusive)', async () => {
      await servicio.consultar('dist-1', {
        from: '2026-10-01',
        to: '2026-10-31',
      });
      for (const c of lecturas()) {
        expect(c.params[0]).toBe('dist-1');
        expect(c.params[1]).toEqual(new Date('2026-10-01T03:00:00.000Z'));
        expect(c.params[2]).toEqual(new Date('2026-11-01T03:00:00.000Z'));
        expect(c.params[3]).toBeNull();
      }
    });

    it('agrupa los períodos en hora argentina', async () => {
      await servicio.consultar('dist-1', {
        from: '2026-10-01',
        to: '2026-10-31',
        groupBy: IncomeStatementGroupBy.WEEK,
      });
      const sql = lecturas().find((c) => c.sql.includes('date_trunc'))?.sql;
      expect(sql).toContain(
        `date_trunc('week', m."occurred_at" AT TIME ZONE 'America/Argentina/Buenos_Aires')`,
      );
    });

    it('informa la carga inicial aparte', async () => {
      const r = await servicio.consultar('dist-1', {
        from: '2026-10-01',
        to: '2026-10-31',
      });
      expect(r.initialLoad).toEqual({ amount: 5000.5, count: 1 });
    });
  });

  describe('resultado', () => {
    it('suma con decimales exactos y calcula el neto', async () => {
      filas.periodos = [
        { period: '2026-10-01', income: '0.10', expense: '0.00' },
        { period: '2026-10-02', income: '0.20', expense: '0.05' },
      ];
      filas.categorias = [
        {
          category_id: 'c1',
          name: 'Cobro de pedido',
          system_code: 'order_payment',
          direction: 'in',
          amount: '0.30',
          count: 2,
        },
      ];
      filas.cajas = [
        {
          cash_box_id: 'b1',
          name: 'Caja central',
          kind: CashBoxKind.CASH,
          income: '0.30',
          expense: '0.05',
        },
      ];

      const r = await servicio.consultar('dist-1', {
        from: '2026-10-01',
        to: '2026-10-02',
      });

      expect(r.totals).toEqual({ income: 0.3, expense: 0.05, net: 0.25 });
      expect(r.byCategory).toEqual([
        {
          categoryId: 'c1',
          name: 'Cobro de pedido',
          systemCode: 'order_payment',
          direction: 'in',
          amount: 0.3,
          count: 2,
        },
      ]);
      expect(r.byCashBox).toEqual([
        {
          cashBoxId: 'b1',
          name: 'Caja central',
          kind: 'cash',
          income: 0.3,
          expense: 0.05,
        },
      ]);
      expect(r.groupBy).toBe('day');
    });

    it('rellena con ceros los períodos sin movimientos', () => {
      const r = periodosDelRango(
        '2026-10-01',
        '2026-10-03',
        IncomeStatementGroupBy.DAY,
        [{ period: '2026-10-02', income: '10', expense: '4' }],
      );
      expect(r).toEqual([
        { period: '2026-10-01', income: 0, expense: 0, net: 0 },
        { period: '2026-10-02', income: 10, expense: 4, net: 6 },
        { period: '2026-10-03', income: 0, expense: 0, net: 0 },
      ]);
    });

    it('el primer período arranca en from y los siguientes en el lunes o el día 1', () => {
      expect(
        periodosDelRango(
          '2026-10-14',
          '2026-10-27',
          IncomeStatementGroupBy.WEEK,
          [],
        ).map((p) => p.period),
      ).toEqual(['2026-10-14', '2026-10-19', '2026-10-26']);
      expect(
        periodosDelRango(
          '2026-09-15',
          '2026-11-02',
          IncomeStatementGroupBy.MONTH,
          [],
        ).map((p) => p.period),
      ).toEqual(['2026-09-15', '2026-10-01', '2026-11-01']);
    });
  });

  describe('validaciones', () => {
    it('rechaza un rango invertido', async () => {
      await expect(
        servicio.consultar('dist-1', { from: '2026-10-05', to: '2026-10-01' }),
      ).rejects.toBeInstanceOf(MovimientoInvalidoError);
    });

    it('rechaza más de 366 días y acepta exactamente 366', async () => {
      await expect(
        servicio.consultar('dist-1', { from: '2026-01-01', to: '2027-01-02' }),
      ).rejects.toThrow('366');
      await expect(
        servicio.consultar('dist-1', { from: '2026-01-01', to: '2027-01-01' }),
      ).resolves.toBeDefined();
    });

    it('rechaza un día que no existe', async () => {
      await expect(
        servicio.consultar('dist-1', { from: '2026-02-30', to: '2026-03-01' }),
      ).rejects.toBeInstanceOf(MovimientoInvalidoError);
    });

    it('una caja de otra distribuidora es "no encontrada"', async () => {
      cajaExiste = false;
      await expect(
        servicio.consultar('dist-1', {
          from: '2026-10-01',
          to: '2026-10-02',
          cashBoxId: 'caja-de-otra',
        }),
      ).rejects.toBeInstanceOf(CajaNoEncontradaError);
      expect(consultas[1].params).toEqual(['caja-de-otra', 'dist-1']);
      expect(lecturas()).toHaveLength(0);
      expect(runnerDeLaPrueba.release).toHaveBeenCalledTimes(1);
    });

    it('filtra por la caja pedida', async () => {
      await servicio.consultar('dist-1', {
        from: '2026-10-01',
        to: '2026-10-02',
        cashBoxId: 'caja-1',
      });
      for (const c of lecturas()) expect(c.params[3]).toBe('caja-1');
    });
  });
});
