import { DataSource, EntityManager } from 'typeorm';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { StockAdminNotifier } from './stock-admin-notifier.service';
import { StockReconciliationCron } from './stock-reconciliation.cron';
import { StockReconciliationService } from './stock-reconciliation.service';
import { StockLowCron } from './stock-low.cron';
import { StockOnHandService } from './stock-on-hand.service';
import { RedisService } from '../../redis/redis.service';
import { ReapplyDeliveriesUseCase } from './reapply-deliveries.use-case';
import {
  ResultadoDeEntrega,
  StockDeliveryService,
} from './stock-delivery.service';
import { EntregaDePedido } from '../../order/domain/ports/stock-delivery.port';

const DIST = 'dddddddd-0000-4000-8000-000000000001';
const G1 = '10000000-0000-4000-8000-000000000001';
const G2 = '10000000-0000-4000-8000-000000000002';

function armarConciliacion(datos: {
  garrafas: Array<{
    gas_cylinder_id: string;
    type: string;
    stock: number;
    reservation_deficit?: number;
  }>;
  fisicas: Array<{ gas_cylinder_id: string; total: string }>;
  reservadas: Record<string, number>;
  desde?: Date | null;
  entregadas?: Array<{
    orderId: string;
    deliveredAt: Date;
    gasCylinderId: string;
    quantity: number;
  }>;
  conMovimiento?: Array<{ reference_id: string; gas_cylinder_id: string }>;
}) {
  const query = jest.fn((sql: string) => {
    if (sql.includes('FROM "gas_cylinder"'))
      return Promise.resolve(
        datos.garrafas.map((g) => ({ reservation_deficit: 0, ...g })),
      );
    if (sql.includes('FROM "stock_balance"'))
      return Promise.resolve(datos.fisicas);
    if (sql.includes('MIN("createdAt")'))
      return Promise.resolve([{ desde: datos.desde ?? null }]);
    if (sql.includes(`"reason" = 'delivery'`))
      return Promise.resolve(datos.conMovimiento ?? []);
    throw new Error(sql);
  });
  const manager = { query } as unknown as EntityManager;
  const transaction = jest.fn(
    (_iso: string, cb: (m: EntityManager) => Promise<unknown>) => cb(manager),
  );
  const dataSource = { transaction } as unknown as DataSource;
  const orders = {
    reservedByCylinder: jest
      .fn()
      .mockResolvedValue(new Map(Object.entries(datos.reservadas))),
    deliveredItemsSince: jest.fn().mockResolvedValue(datos.entregadas ?? []),
  };
  const service = new StockReconciliationService(
    dataSource,
    orders as unknown as OrderLookupService,
    new StockOnHandService(),
  );
  return { service, transaction, query, orders, manager };
}

describe('StockReconciliationService (invariante del vendible, D4)', () => {
  it('cierra cuando vendible = llenas − reservadas en todas las garrafas', async () => {
    const { service } = armarConciliacion({
      garrafas: [{ gas_cylinder_id: G1, type: '10kg', stock: 70 }],
      fisicas: [{ gas_cylinder_id: G1, total: '100' }],
      reservadas: { [G1]: 30 },
    });
    const r = await service.conciliar(DIST);
    expect(r.consistent).toBe(true);
    expect(r.cylinders[0]).toMatchObject({ expected: 70, difference: 0 });
  });

  it('detecta una garrafa descuadrada y informa la diferencia (no corrige)', async () => {
    const { service, query } = armarConciliacion({
      garrafas: [
        { gas_cylinder_id: G1, type: '10kg', stock: 70 },
        { gas_cylinder_id: G2, type: '15kg', stock: 50 },
      ],
      fisicas: [
        { gas_cylinder_id: G1, total: '100' },
        { gas_cylinder_id: G2, total: '40' },
      ],
      reservadas: { [G1]: 30, [G2]: 0 },
    });
    const r = await service.conciliar(DIST);
    expect(r.consistent).toBe(false);
    expect(r.cylinders.find((c) => c.gasCylinderId === G2)).toMatchObject({
      sellable: 50,
      expected: 40,
      difference: 10,
    });
    const escrituras = query.mock.calls.filter((c) =>
      /INSERT|UPDATE|DELETE/i.test(c[0]),
    );
    expect(escrituras).toHaveLength(0);
  });

  it('una garrafa sin saldo físico cuenta como cero llenas', async () => {
    const { service } = armarConciliacion({
      garrafas: [{ gas_cylinder_id: G1, type: '10kg', stock: 5 }],
      fisicas: [],
      reservadas: {},
    });
    expect((await service.conciliar(DIST)).cylinders[0]).toMatchObject({
      physicalFull: 0,
      difference: 5,
    });
  });

  it('lee las tres cifras en una transacción REPEATABLE READ (mismo instante)', async () => {
    const { service, transaction, orders, manager } = armarConciliacion({
      garrafas: [],
      fisicas: [],
      reservadas: {},
    });
    await service.conciliar(DIST);
    expect(transaction.mock.calls[0][0]).toBe('REPEATABLE READ');
    expect(orders.reservedByCylinder).toHaveBeenCalledWith(DIST, manager);
  });

  it('lista las entregas posteriores al arranque que no descontaron el físico', async () => {
    const entregadas = [
      {
        orderId: 'o1',
        deliveredAt: new Date(),
        gasCylinderId: G1,
        quantity: 2,
      },
      {
        orderId: 'o2',
        deliveredAt: new Date(),
        gasCylinderId: G1,
        quantity: 1,
      },
    ];
    const { service, orders } = armarConciliacion({
      garrafas: [{ gas_cylinder_id: G1, type: '10kg', stock: 70 }],
      fisicas: [{ gas_cylinder_id: G1, total: '100' }],
      reservadas: { [G1]: 30 },
      desde: new Date('2026-10-01'),
      entregadas,
      conMovimiento: [{ reference_id: 'o1', gas_cylinder_id: G1 }],
    });
    const r = await service.conciliar(DIST);
    expect(orders.deliveredItemsSince).toHaveBeenCalledWith(
      DIST,
      new Date('2026-10-01'),
      expect.anything(),
    );
    expect(r.deliveriesWithoutMovement).toEqual([
      expect.objectContaining({
        orderId: 'o2',
        gasCylinderType: '10kg',
        quantity: 1,
      }),
    ]);
    expect(r.consistent).toBe(false);
  });

  it('reservas por encima del físico: el vendible queda en 0, no negativo, y se informa el exceso', async () => {
    const { service } = armarConciliacion({
      garrafas: [{ gas_cylinder_id: G1, type: '10kg', stock: 0 }],
      fisicas: [{ gas_cylinder_id: G1, total: '3' }],
      reservadas: { [G1]: 5 },
    });
    const r = await service.conciliar(DIST);
    expect(r.cylinders[0]).toMatchObject({
      expected: 0,
      difference: 0,
      overReserved: 2,
      correction: 0,
    });
    expect(r.consistent).toBe(false);
  });

  it('el déficit guardado se muestra y un desfasaje con diferencia 0 deja la conciliación en inconsistente', async () => {
    // vendible 0 = esperado 0, pero el déficit guardado (1) no es el real (7 − 4 = 3)
    const { service } = armarConciliacion({
      garrafas: [
        { gas_cylinder_id: G1, type: '10kg', stock: 0, reservation_deficit: 1 },
      ],
      fisicas: [{ gas_cylinder_id: G1, total: '4' }],
      reservadas: { [G1]: 7 },
    });
    const r = await service.conciliar(DIST);
    expect(r.cylinders[0]).toMatchObject({
      difference: 0,
      overReserved: 3,
      reservationDeficit: 1,
      deficitDifference: -2,
    });
    expect(r.consistent).toBe(false);
  });

  it('un déficit guardado sin reservas de más es inconsistente aunque el vendible cierre', async () => {
    const { service } = armarConciliacion({
      garrafas: [
        { gas_cylinder_id: G1, type: '10kg', stock: 0, reservation_deficit: 2 },
      ],
      fisicas: [{ gas_cylinder_id: G1, total: '10' }],
      reservadas: { [G1]: 10 },
    });
    const r = await service.conciliar(DIST);
    expect(r.cylinders[0]).toMatchObject({
      difference: 0,
      overReserved: 0,
      deficitDifference: 2,
    });
    expect(r.consistent).toBe(false);
  });

  it('un déficit guardado que coincide con las reservas de más es consistente en el déficit', async () => {
    const { service } = armarConciliacion({
      garrafas: [
        { gas_cylinder_id: G1, type: '10kg', stock: 0, reservation_deficit: 3 },
      ],
      fisicas: [{ gas_cylinder_id: G1, total: '4' }],
      reservadas: { [G1]: 7 },
    });
    const r = await service.conciliar(DIST);
    expect(r.cylinders[0].deficitDifference).toBe(0);
  });

  it('sin movimientos de arranque no hay entregas que auditar', async () => {
    const { service, orders } = armarConciliacion({
      garrafas: [],
      fisicas: [],
      reservadas: {},
      desde: null,
    });
    const r = await service.conciliar(DIST);
    expect(orders.deliveredItemsSince).not.toHaveBeenCalled();
    expect(r.deliveriesWithoutMovement).toEqual([]);
  });
});

/** Un Redis donde siempre se obtiene el lock, o donde otra instancia ya lo tiene. */
const redisConLock = (obtenido = true) => {
  const withLock = jest.fn(
    async (_k: string, _t: number, fn: () => Promise<unknown>) =>
      obtenido ? { obtenido: true, valor: await fn() } : { obtenido: false },
  );
  return { redis: { withLock } as unknown as RedisService, withLock };
};

describe('StockReconciliationCron', () => {
  const cilindro = (over: Record<string, unknown> = {}) => ({
    gasCylinderId: G1,
    gasCylinderType: '10kg',
    sellable: 5,
    physicalFull: 0,
    reserved: 0,
    expected: 0,
    overReserved: 0,
    difference: 5,
    ...over,
  });
  /** Lo que devuelve el CALL (parámetros INOUT) cuando hay diferencias. */
  const conDiferencias = (
    cylinders = [cilindro()],
    over: Record<string, unknown> = {},
  ) => [
    {
      p_consistente: false,
      p_avisar: true,
      p_firma: 'f'.repeat(64),
      p_resultado: {
        consistent: false,
        cylinders,
        deliveriesWithoutMovement: [],
      },
      ...over,
    },
  ];
  const cierra = [
    {
      p_consistente: true,
      p_avisar: false,
      p_firma: null,
      p_resultado: {
        consistent: true,
        cylinders: [],
        deliveriesWithoutMovement: [],
      },
    },
  ];
  const armar = (llamadas: unknown[][]) => {
    const query = jest.fn((sql: string) => {
      if (sql.startsWith('CALL'))
        return Promise.resolve(llamadas.shift() ?? cierra);
      return Promise.resolve([]);
    });
    const avisar = jest
      .fn<Promise<boolean>, [string, string, string]>()
      .mockResolvedValue(true);
    const cron = new StockReconciliationCron(
      { query } as unknown as DataSource,
      { avisar } as unknown as StockAdminNotifier,
      redisConLock().redis,
    );
    return { cron, avisar, query };
  };

  it('llama al procedimiento con la distribuidora', async () => {
    const { cron, query } = armar([cierra]);
    await cron.conciliar(DIST);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('CALL conciliar_stock_del_dia($1,'),
      [DIST],
    );
  });

  it('avisa por email si hay diferencias y NO corrige nada', async () => {
    const { cron, avisar, query } = armar([conDiferencias()]);
    await cron.conciliar(DIST);
    expect(avisar).toHaveBeenCalledWith(
      DIST,
      expect.stringContaining('diferencias') as string,
      expect.stringContaining('10kg') as string,
    );
    // Lo único que escribe el cron es la huella del aviso.
    const escrituras = query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => !sql.startsWith('CALL') && !sql.startsWith('SELECT'));
    expect(escrituras).toHaveLength(1);
    expect(escrituras[0]).toContain('INSERT INTO "stock_reconciliation_alert"');
  });

  it('guarda la huella que devolvió el procedimiento, después de avisar', async () => {
    const { cron, query } = armar([conDiferencias()]);
    await cron.conciliar(DIST);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('INSERT INTO "stock_reconciliation_alert"'),
      [DIST, 'f'.repeat(64)],
    );
  });

  it('si el procedimiento dice que la diferencia ya se avisó, no manda ni guarda nada', async () => {
    const { cron, avisar, query } = armar([
      conDiferencias([cilindro()], { p_avisar: false }),
    ]);
    await cron.conciliar(DIST);
    expect(avisar).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('si todo cierra no manda nada', async () => {
    const { cron, avisar } = armar([cierra]);
    await cron.conciliar(DIST);
    expect(avisar).not.toHaveBeenCalled();
  });

  it('si el mail falla no guarda la huella: el próximo desvío vuelve a avisar', async () => {
    const { cron, avisar, query } = armar([conDiferencias()]);
    avisar.mockRejectedValueOnce(new Error('smtp'));
    await cron.conciliar(DIST);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('INSERT')),
    ).toBe(false);
  });

  it('un fallo del procedimiento en una distribuidora no corta a las demás', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { distributor_id: 'd1' },
        { distributor_id: 'd2' },
      ])
      .mockRejectedValueOnce(new Error('conciliar_stock_del_dia falló'))
      .mockResolvedValueOnce(cierra);
    const cron = new StockReconciliationCron(
      { query } as unknown as DataSource,
      { avisar: jest.fn() } as unknown as StockAdminNotifier,
      redisConLock().redis,
    );
    await cron.conciliarTodas();
    const calls = query.mock.calls.filter(([sql]) =>
      String(sql).startsWith('CALL'),
    );
    expect(calls.map(([, params]) => (params as string[])[0])).toEqual([
      'd1',
      'd2',
    ]);
  });

  it('con varias instancias corre una sola: si otra tiene el lock, no concilia ni avisa', async () => {
    const dataSource = { query: jest.fn() };
    const { redis, withLock } = redisConLock(false);
    const cron = new StockReconciliationCron(
      dataSource as unknown as DataSource,
      { avisar: jest.fn() } as unknown as StockAdminNotifier,
      redis,
    );
    await cron.conciliarTodas();
    expect(withLock).toHaveBeenCalledWith(
      'cron:stock-reconciliation',
      expect.any(Number),
      expect.any(Function),
    );
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('un exceso de reservas sobre el físico aparece en el mail', async () => {
    const { cron, avisar } = armar([
      conDiferencias([
        cilindro({
          sellable: 0,
          physicalFull: 3,
          reserved: 5,
          overReserved: 2,
          difference: 0,
        }),
      ]),
    ]);
    await cron.conciliar(DIST);
    expect(avisar.mock.calls[0]?.[2]).toMatch(
      /2 reservada\(s\) de más que el físico no cubre/,
    );
  });
});

describe('StockLowCron (alerted_at)', () => {
  const fila = (over: Record<string, unknown>) => ({
    threshold_id: 't1',
    distributor_id: DIST,
    warehouse_name: 'Central',
    type: '10kg',
    min_full: 20,
    current_full: 5,
    alerted_at: null,
    ...over,
  });
  const armar = (filas: unknown[], emailFalla = false, lock = true) => {
    const { redis, withLock } = redisConLock(lock);
    const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>((sql) =>
      sql.includes('SELECT') ? Promise.resolve(filas) : Promise.resolve([]),
    );
    const avisar = jest.fn<Promise<boolean>, [string, string, string]>();
    if (emailFalla) avisar.mockRejectedValue(new Error('smtp'));
    else avisar.mockResolvedValue(true);
    const cron = new StockLowCron(
      { query } as unknown as DataSource,
      { avisar } as unknown as StockAdminNotifier,
      redis,
    );
    return { cron, query, avisar, withLock };
  };
  const escrituras = (
    query: jest.Mock<Promise<unknown[]>, [string, unknown[]?]>,
  ) => query.mock.calls.filter((c) => c[0].includes('UPDATE'));

  it('avisa lo que bajó del mínimo y marca alerted_at', async () => {
    const { cron, avisar, query } = armar([fila({})]);
    await cron.avisarStockBajo();
    expect(avisar).toHaveBeenCalledTimes(1);
    expect(avisar.mock.calls[0][2]).toContain('Central');
    expect(escrituras(query)[0][0]).toContain('"alerted_at" = now()');
    expect(escrituras(query)[0][1]).toEqual([['t1']]);
  });

  it('no repite el aviso mientras siga bajo el mínimo', async () => {
    const { cron, avisar, query } = armar([fila({ alerted_at: new Date() })]);
    await cron.avisarStockBajo();
    expect(avisar).not.toHaveBeenCalled();
    expect(escrituras(query)).toHaveLength(0);
  });

  it('cuando el depósito se recupera limpia alerted_at para volver a avisar después', async () => {
    const { cron, avisar, query } = armar([
      fila({ current_full: 30, alerted_at: new Date() }),
    ]);
    await cron.avisarStockBajo();
    expect(avisar).not.toHaveBeenCalled();
    expect(escrituras(query)[0][0]).toContain('"alerted_at" = NULL');
  });

  it('con mínimo cero no avisa nunca', async () => {
    const { cron, avisar } = armar([fila({ min_full: 0, current_full: 0 })]);
    await cron.avisarStockBajo();
    expect(avisar).not.toHaveBeenCalled();
  });

  it('si el envío falla NO marca alerted_at: se reintenta mañana', async () => {
    const { cron, query } = armar([fila({})], true);
    await cron.avisarStockBajo();
    expect(escrituras(query)).toHaveLength(0);
  });

  it('con varias instancias corre una sola: si otra tiene el lock, no avisa', async () => {
    const { cron, avisar, query, withLock } = armar([fila({})], false, false);
    await cron.avisarStockBajo();
    expect(withLock).toHaveBeenCalledWith(
      'cron:stock-low',
      expect.any(Number),
      expect.any(Function),
    );
    expect(query).not.toHaveBeenCalled();
    expect(avisar).not.toHaveBeenCalled();
  });

  it('agrupa por distribuidora: un mail por cada una', async () => {
    const { cron, avisar } = armar([
      fila({}),
      fila({ threshold_id: 't2', distributor_id: 'otra' }),
    ]);
    await cron.avisarStockBajo();
    expect(avisar).toHaveBeenCalledTimes(2);
  });
});

describe('ReapplyDeliveriesUseCase', () => {
  it('reaplica por pedido (agrupando renglones) y cuenta reaplicados y pendientes', async () => {
    const consultas: string[] = [];
    const dataSource = {
      manager: {
        query: jest.fn((sql: string) => {
          consultas.push(sql);
          return Promise.resolve([{ desde: new Date('2026-10-01') }]);
        }),
      },
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb({})),
    };
    const orders = {
      deliveredItemsSince: jest.fn().mockResolvedValue([
        { orderId: 'o1', vehicleCarId: 'c1', gasCylinderId: G1, quantity: '2' },
        { orderId: 'o1', vehicleCarId: 'c1', gasCylinderId: G2, quantity: '1' },
        { orderId: 'o2', vehicleCarId: null, gasCylinderId: G1, quantity: '4' },
        { orderId: 'o3', vehicleCarId: null, gasCylinderId: G1, quantity: '1' },
      ]),
    };
    const delivery = {
      registrarEntrega: jest
        .fn<Promise<ResultadoDeEntrega>, [unknown, EntregaDePedido]>()
        .mockResolvedValueOnce({
          aplicadas: [
            { gasCylinderId: G1, origen: 'vehiculo' },
            { gasCylinderId: G2, origen: 'vehiculo' },
          ],
          omitidas: [],
        })
        .mockResolvedValueOnce({ aplicadas: [], omitidas: [G1] })
        .mockResolvedValueOnce({ aplicadas: [], omitidas: [] }),
    };
    const uc = new ReapplyDeliveriesUseCase(
      dataSource as unknown as DataSource,
      orders as unknown as OrderLookupService,
      delivery as unknown as StockDeliveryService,
      new StockOnHandService(),
    );
    const r = await uc.execute(DIST);
    // el piso es cuándo se asentó el primer movimiento, no la fecha que el usuario le puso
    expect(consultas[0]).toContain('MIN("createdAt")');
    expect(consultas[0]).not.toContain('occurred_at');
    expect(orders.deliveredItemsSince).toHaveBeenCalledWith(
      DIST,
      new Date('2026-10-01'),
    );
    expect(delivery.registrarEntrega).toHaveBeenCalledTimes(3);
    expect(delivery.registrarEntrega.mock.calls[0][1]).toMatchObject({
      orderId: 'o1',
      items: [
        { gasCylinderId: G1, quantity: 2 },
        { gasCylinderId: G2, quantity: 1 },
      ],
    });
    // o3 ya estaba registrada: no cuenta.
    expect(r).toEqual({ revisados: 2, reaplicados: 1, pendientes: 1 });
  });
});
