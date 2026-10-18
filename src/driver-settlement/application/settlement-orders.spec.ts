import { EntityManager } from 'typeorm';
import {
  choferesConPedidosSinRendir,
  pedidosSinRendir,
} from './settlement-orders';

describe('settlement-orders', () => {
  let consultas: Array<{ sql: string; params: unknown[] }>;
  let manager: EntityManager;

  beforeEach(() => {
    consultas = [];
    manager = {
      query: jest.fn((sql: string, params: unknown[]) => {
        consultas.push({ sql, params });
        return Promise.resolve([
          { distributor_id: 'dist-1', delivery_id: 'chofer-1' },
        ]);
      }),
    } as unknown as EntityManager;
  });

  describe('choferesConPedidosSinRendir (candidatura del proceso nocturno)', () => {
    it('acota el día argentino con un instante (timestamptz), no con un date + 1', async () => {
      await choferesConPedidosSinRendir(manager, '2026-10-17');
      const { sql, params } = consultas[0];
      // 17/10 completo en ART = hasta el 18/10 03:00 UTC.
      expect(params[0]).toEqual(new Date('2026-10-18T03:00:00.000Z'));
      expect(params[1]).toBe('2026-10-17');
      expect(sql).not.toContain('::date + 1');
      expect(sql).toContain('o."deliveredAt" < $1');
    });

    it('aplica la misma regla que la lectura de la rendición', async () => {
      await choferesConPedidosSinRendir(manager, '2026-10-17');
      await pedidosSinRendir(manager, {
        distributorId: 'dist-1',
        deliveryId: 'chofer-1',
        businessDate: '2026-10-17',
      });
      const normalizar = (sql: string) =>
        sql.replace(/\$\d/g, '$').replace(/\s+/g, ' ');
      const [candidatura, lectura] = consultas.map((c) => normalizar(c.sql));
      for (const regla of [
        `o."payment_resolved_by" IS NULL`,
        `o."paymentStatus" IN ('paid', 'pending')`,
        `d."order_id" = o."order_id"`,
        `s."status" = 'open'`,
      ]) {
        expect(candidatura).toContain(regla);
        expect(lectura).toContain(regla);
      }
    });

    it('no abre rendición si el día es inválido', async () => {
      await expect(
        choferesConPedidosSinRendir(manager, '2026-13-40'),
      ).resolves.toEqual([]);
      expect(consultas).toHaveLength(0);
    });
  });

  describe('pedidosSinRendir', () => {
    it('excluye los pedidos que cobró o resolvió un administrador', async () => {
      await pedidosSinRendir(manager, {
        distributorId: 'dist-1',
        deliveryId: 'chofer-1',
        businessDate: '2026-10-17',
      });
      expect(consultas[0].sql).toContain('o."payment_resolved_by" IS NULL');
    });
  });
});
