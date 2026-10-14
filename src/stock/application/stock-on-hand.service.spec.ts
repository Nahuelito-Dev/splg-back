import type { EntityManager } from 'typeorm';
import { StockOnHandService } from './stock-on-hand.service';

const DIST = 'dddddddd-0000-4000-8000-000000000001';
const WH = 'a0000000-0000-4000-8000-000000000001';

const managerCon = (filas: unknown[]) => {
  const query = jest
    .fn<Promise<unknown[]>, [string, unknown[]]>()
    .mockResolvedValue(filas);
  return { manager: { query } as unknown as EntityManager, query };
};

describe('StockOnHandService — inicio del stock', () => {
  const service = new StockOnHandService();

  describe('inicioDelLibro', () => {
    it('es el momento en que se asentó el primer movimiento (createdAt), no la fecha que eligió el usuario (occurred_at)', async () => {
      const desde = new Date('2026-10-11T20:02:14Z');
      const { manager, query } = managerCon([{ desde }]);
      await expect(service.inicioDelLibro(manager, DIST)).resolves.toBe(desde);
      const sql = String(query.mock.calls[0][0]);
      expect(sql).toContain('MIN("createdAt")');
      expect(sql).not.toContain('occurred_at');
      expect(query.mock.calls[0][1]).toEqual([DIST]);
    });

    it('null si todavía no hay movimientos', async () => {
      const { manager } = managerCon([{ desde: null }]);
      await expect(service.inicioDelLibro(manager, DIST)).resolves.toBeNull();
    });
  });

  describe('inicioDeStockDelDeposito', () => {
    it('es el conteo inicial del depósito, filtrado por distribuidora y depósito', async () => {
      const desde = new Date('2026-10-11T20:00:00Z');
      const { manager, query } = managerCon([{ desde }]);
      await expect(
        service.inicioDeStockDelDeposito(manager, DIST, WH),
      ).resolves.toBe(desde);
      const sql = String(query.mock.calls[0][0]);
      expect(sql).toContain(`a."reason" = 'initial_count'`);
      expect(sql).not.toContain('"warehouse" w');
      expect(query.mock.calls[0][1]).toEqual([DIST, WH]);
    });

    it('sin conteo inicial no hay piso (null): no se inventa uno con el alta del depósito', async () => {
      const { manager } = managerCon([{ desde: null }]);
      await expect(
        service.inicioDeStockDelDeposito(manager, DIST, WH),
      ).resolves.toBeNull();
    });
  });
});
