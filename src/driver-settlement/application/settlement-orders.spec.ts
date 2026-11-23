import { EntityManager } from 'typeorm';
import {
  choferesConPedidosSinRendir,
  efectivoSinRendirPorChofer,
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

    it('con bloquear, toma los pedidos FOR UPDATE para que un cobro del admin concurrente no se cuele', async () => {
      await pedidosSinRendir(
        manager,
        {
          distributorId: 'dist-1',
          deliveryId: 'chofer-1',
          businessDate: '2026-10-17',
        },
        { bloquear: true },
      );
      expect(consultas[0].sql).toMatch(/FOR UPDATE OF o\s*$/);
    });

    it('sin bloquear (lecturas) no bloquea nada', async () => {
      await pedidosSinRendir(manager, {
        distributorId: 'dist-1',
        deliveryId: 'chofer-1',
        businessDate: '2026-10-17',
      });
      expect(consultas[0].sql).not.toContain('FOR UPDATE');
    });
  });
});

describe('efectivoSinRendirPorChofer', () => {
  const ahora = new Date('2026-11-22T23:00:00Z');
  const fila = (
    delivery: string,
    nombre: string,
    total: string,
    sena: string,
    entregado: string,
  ) => ({
    delivery_id: delivery,
    driver_name: nombre,
    total,
    sena,
    delivered_at: new Date(entregado),
  });
  const armar = (filas: unknown[]) =>
    ({
      query: jest.fn().mockResolvedValue(filas),
    }) as unknown as EntityManager;

  it('agrupa por chofer, descuenta la seña paga y ordena del más viejo al más nuevo', async () => {
    const r = await efectivoSinRendirPorChofer(
      armar([
        fila('ch1', 'Ana', '10000', '0', '2026-11-20T12:00:00Z'),
        fila('ch2', 'Beto', '9000', '0', '2026-11-19T12:00:00Z'),
        fila('ch1', 'Ana', '8000', '3000', '2026-11-21T12:00:00Z'),
      ]),
      'd1',
      { ahora },
    );

    expect(r.map((c) => c.deliveryId)).toEqual(['ch2', 'ch1']);
    expect(r[1]).toMatchObject({
      driverName: 'Ana',
      orders: 2,
      amount: 15000,
      ageHours: 59,
    });
  });

  it('con masViejosDeHoras sólo cuenta lo entregado hace al menos esas horas', async () => {
    const r = await efectivoSinRendirPorChofer(
      armar([
        fila('ch1', 'Ana', '10000', '0', '2026-11-20T12:00:00Z'),
        fila('ch1', 'Ana', '5000', '0', '2026-11-22T20:00:00Z'),
        fila('ch2', 'Beto', '7000', '0', '2026-11-22T21:00:00Z'),
      ]),
      'd1',
      { ahora, masViejosDeHoras: 24 },
    );

    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ deliveryId: 'ch1', orders: 1, amount: 10000 });
  });

  it('la consulta excluye lo que una rendición ya tomó y lo que resolvió el admin', async () => {
    const manager = armar([]);
    await efectivoSinRendirPorChofer(manager, 'd1');
    const [sql, params] = (manager.query as jest.Mock).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('"driver_settlement_order"');
    expect(sql).toContain('"payment_resolved_by" IS NULL');
    expect(params).toEqual(['d1']);
  });
});
