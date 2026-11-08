import { EntityManager } from 'typeorm';
import {
  OperacionDeStock,
  ResultadoDeOperacion,
  StockLedgerPort,
} from '../domain/ports/stock-ledger.port';
import {
  StockCondition as Cond,
  StockMovementReason as Razon,
  StockReferenceType,
} from '../domain/stock.enums';
import { StockDeliveryService } from './stock-delivery.service';
import { StockLocationService } from './stock-location.service';
import { WarehouseService } from './warehouse.service';
import { StockInsuficienteError } from '../domain/errors/stock.errors';

const DIST = 'dddddddd-0000-4000-8000-000000000001';
const DEPOSITO = 'dep-loc';
const CAMION = 'cam-loc';
const G1 = '10000000-0000-4000-8000-000000000001';
const G2 = '10000000-0000-4000-8000-000000000002';

function armar(opts: {
  /** `ubicación|garrafa` → llenas */
  llenas?: Record<string, number>;
  yaRegistradas?: string[];
  camion?: boolean;
}) {
  const query = jest.fn((sql: string) => {
    if (sql.includes(`"reason" = 'delivery'`)) {
      return Promise.resolve(
        (opts.yaRegistradas ?? []).map((g) => ({ gas_cylinder_id: g })),
      );
    }
    if (sql.includes('FROM "stock_balance"')) {
      return Promise.resolve(
        Object.entries(opts.llenas ?? {}).map(([k, quantity]) => {
          const [location_id, gas_cylinder_id] = k.split('|');
          return { location_id, gas_cylinder_id, quantity };
        }),
      );
    }
    throw new Error(`SQL no esperado: ${sql}`);
  });
  const manager = {
    query,
    transaction: jest.fn((cb: (m: unknown) => Promise<void>) => cb(manager)),
  } as unknown as EntityManager;
  const ledger = {
    aplicar: jest
      .fn<Promise<ResultadoDeOperacion>, [EntityManager, OperacionDeStock]>()
      .mockResolvedValue({ batchId: 'b', movementIds: [] }),
  };
  const locations = {
    ubicacionExistenteDeVehiculo: jest
      .fn()
      .mockResolvedValue(opts.camion === false ? null : { locationId: CAMION }),
  };
  const warehouses = {
    asegurarPredeterminado: jest
      .fn()
      .mockResolvedValue({ locationId: DEPOSITO }),
  };
  const service = new StockDeliveryService(
    ledger as unknown as StockLedgerPort,
    locations as unknown as StockLocationService,
    warehouses as unknown as WarehouseService,
  );
  return { service, manager, ledger, locations, warehouses, query };
}

const entrega = (
  items: Array<{
    gasCylinderId: string;
    quantity: number;
    containersCharged?: number;
    emptiesReceived?: number | null;
  }> = [{ gasCylinderId: G1, quantity: 2 }],
  car: string | null = 'car-1',
) => ({
  orderId: 'ord-1',
  distributorId: DIST,
  vehicleCarId: car,
  items: items.map((item) => ({
    containersCharged: 0,
    emptiesReceived: null,
    ...item,
  })),
});

describe('StockDeliveryService (entrega de un pedido: D5 y D6)', () => {
  it('con cero vacías recibidas no registra movimiento de vacías', async () => {
    const { service, manager, ledger } = armar({
      llenas: { [`${CAMION}|${G1}`]: 10 },
    });

    await service.registrarEntrega(
      manager,
      entrega([
        {
          gasCylinderId: G1,
          quantity: 2,
          containersCharged: 0,
          emptiesReceived: 0,
        },
      ]),
    );

    expect(ledger.aplicar.mock.calls[0][1].movimientos).toEqual([
      expect.objectContaining({ reason: Razon.DELIVERY, quantity: 2 }),
    ]);
  });

  it('sin declaración toma quantity menos los envases cobrados', async () => {
    const { service, manager, ledger } = armar({
      llenas: { [`${CAMION}|${G1}`]: 10 },
    });

    await service.registrarEntrega(
      manager,
      entrega([
        {
          gasCylinderId: G1,
          quantity: 3,
          containersCharged: 1,
          emptiesReceived: null,
        },
      ]),
    );

    expect(ledger.aplicar.mock.calls[0][1].movimientos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: Razon.EMPTY_COLLECTED, quantity: 2 }),
      ]),
    );
  });
  it('descuenta la llena del camión del chofer si tiene saldo y suma la vacía de canje 1:1', async () => {
    const { service, manager, ledger } = armar({
      llenas: { [`${CAMION}|${G1}`]: 10, [`${DEPOSITO}|${G1}`]: 50 },
    });

    const r = await service.registrarEntrega(manager, entrega());

    expect(r.aplicadas).toEqual([{ gasCylinderId: G1, origen: 'vehiculo' }]);
    expect(ledger.aplicar).toHaveBeenCalledTimes(1);
    expect(ledger.aplicar).toHaveBeenCalledWith(manager, {
      distributorId: DIST,
      referenceType: StockReferenceType.ORDER,
      referenceId: 'ord-1',
      actorUserId: null,
      vendible: 'sin-cambio',
      movimientos: [
        {
          gasCylinderId: G1,
          quantity: 2,
          from: { locationId: CAMION, condition: Cond.FULL },
          to: null,
          reason: Razon.DELIVERY,
        },
        {
          gasCylinderId: G1,
          quantity: 2,
          from: null,
          to: { locationId: CAMION, condition: Cond.EMPTY },
          reason: Razon.EMPTY_COLLECTED,
        },
      ],
    });
  });

  it('sin saldo en el camión cae al depósito predeterminado (no bloquea la entrega)', async () => {
    const { service, manager, ledger } = armar({
      llenas: { [`${CAMION}|${G1}`]: 1, [`${DEPOSITO}|${G1}`]: 50 },
    });
    const r = await service.registrarEntrega(manager, entrega());
    expect(r.aplicadas).toEqual([{ gasCylinderId: G1, origen: 'deposito' }]);
    const op = ledger.aplicar.mock.calls[0][1];
    expect(op.movimientos[0].from?.locationId).toBe(DEPOSITO);
  });

  it('un pedido sin vehículo o con un vehículo sin ubicación sale del depósito', async () => {
    const sinVehiculo = armar({ llenas: { [`${DEPOSITO}|${G1}`]: 5 } });
    await sinVehiculo.service.registrarEntrega(
      sinVehiculo.manager,
      entrega(undefined, null),
    );
    expect(
      sinVehiculo.locations.ubicacionExistenteDeVehiculo,
    ).not.toHaveBeenCalled();
    expect(sinVehiculo.ledger.aplicar).toHaveBeenCalledTimes(1);

    const sinUbicacion = armar({
      llenas: { [`${DEPOSITO}|${G1}`]: 5 },
      camion: false,
    });
    const r = await sinUbicacion.service.registrarEntrega(
      sinUbicacion.manager,
      entrega(),
    );
    expect(r.aplicadas[0].origen).toBe('deposito');
  });

  it('sin saldo en ningún lado no escribe, no tira error y deja la garrafa como omitida', async () => {
    const { service, manager, ledger } = armar({ llenas: {} });
    const r = await service.registrarEntrega(manager, entrega());
    expect(r).toEqual({ aplicadas: [], omitidas: [G1] });
    expect(ledger.aplicar).not.toHaveBeenCalled();
  });

  it('descuenta lo que puede y omite lo que no: una garrafa por camión y otra sin saldo', async () => {
    const { service, manager, ledger } = armar({
      llenas: { [`${CAMION}|${G1}`]: 5 },
    });
    const r = await service.registrarEntrega(
      manager,
      entrega([
        { gasCylinderId: G2, quantity: 1 },
        { gasCylinderId: G1, quantity: 2 },
      ]),
    );
    expect(r.aplicadas).toEqual([{ gasCylinderId: G1, origen: 'vehiculo' }]);
    expect(r.omitidas).toEqual([G2]);
    expect(ledger.aplicar).toHaveBeenCalledTimes(1);
  });

  it('es idempotente por pedido y garrafa: lo ya registrado no se vuelve a descontar', async () => {
    const { service, manager, ledger } = armar({
      llenas: { [`${CAMION}|${G1}`]: 5 },
      yaRegistradas: [G1],
    });
    const r = await service.registrarEntrega(manager, entrega());
    expect(r).toEqual({ aplicadas: [], omitidas: [] });
    expect(ledger.aplicar).not.toHaveBeenCalled();
  });

  it('suma los renglones repetidos de la misma garrafa y los procesa en orden de id', async () => {
    const { service, manager, ledger } = armar({
      llenas: { [`${CAMION}|${G1}`]: 9, [`${CAMION}|${G2}`]: 9 },
    });
    await service.registrarEntrega(
      manager,
      entrega([
        { gasCylinderId: G2, quantity: 1 },
        { gasCylinderId: G1, quantity: 2 },
        { gasCylinderId: G1, quantity: 3 },
      ]),
    );
    const op = ledger.aplicar.mock.calls[0][1];
    expect(op.movimientos.map((m) => [m.gasCylinderId, m.quantity])).toEqual([
      [G1, 5],
      [G1, 5],
      [G2, 1],
      [G2, 1],
    ]);
  });

  it('corre en un savepoint y usa el manager que le pasan (el de la transacción del pedido)', async () => {
    const { service, manager, ledger } = armar({
      llenas: { [`${CAMION}|${G1}`]: 5 },
    });
    await service.registrarEntrega(manager, entrega());
    expect(
      (manager as unknown as { transaction: jest.Mock }).transaction,
    ).toHaveBeenCalledTimes(1);
    expect(ledger.aplicar.mock.calls[0][0]).toBe(manager);
  });

  it('si el libro falla (saldo que cambió en el medio, deadlock) la entrega sigue', async () => {
    const { service, manager, ledger } = armar({
      llenas: { [`${CAMION}|${G1}`]: 5 },
    });
    ledger.aplicar.mockRejectedValueOnce(new StockInsuficienteError([]));
    await expect(
      service.onOrderDelivered(manager, entrega()),
    ).resolves.toBeUndefined();
    const r = await service.registrarEntrega(manager, entrega());
    expect(r.aplicadas).toHaveLength(1);
  });

  it('si un saldo se vació entre la lectura y el libro, reintenta releyendo: descuenta las que alcanzan y omite sólo la que no', async () => {
    const { service, manager, ledger, query } = armar({
      llenas: { [`${DEPOSITO}|${G1}`]: 5, [`${DEPOSITO}|${G2}`]: 5 },
    });
    // Entre el primer intento y el segundo, G2 se quedó sin saldo.
    ledger.aplicar.mockImplementationOnce(() => {
      query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes(`"reason" = 'delivery'`)
            ? []
            : [
                { location_id: DEPOSITO, gas_cylinder_id: G1, quantity: 5 },
                { location_id: DEPOSITO, gas_cylinder_id: G2, quantity: 0 },
              ],
        ),
      );
      return Promise.reject(new StockInsuficienteError([]));
    });
    const r = await service.registrarEntrega(
      manager,
      entrega(
        [
          { gasCylinderId: G1, quantity: 2 },
          { gasCylinderId: G2, quantity: 2 },
        ],
        null,
      ),
    );
    expect(ledger.aplicar).toHaveBeenCalledTimes(2);
    expect(r.aplicadas).toEqual([{ gasCylinderId: G1, origen: 'deposito' }]);
    expect(r.omitidas).toEqual([G2]);
  });

  it('reintenta el savepoint ante un deadlock (40P01) y termina descontando', async () => {
    const { service, manager, ledger } = armar({
      llenas: { [`${CAMION}|${G1}`]: 5 },
    });
    ledger.aplicar.mockRejectedValueOnce(
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    );
    const r = await service.registrarEntrega(manager, entrega());
    expect(ledger.aplicar).toHaveBeenCalledTimes(2);
    expect(r.aplicadas).toHaveLength(1);
  });

  it('otro error no se reintenta', async () => {
    const { service, manager, ledger } = armar({
      llenas: { [`${CAMION}|${G1}`]: 5 },
    });
    ledger.aplicar.mockRejectedValue(new Error('boom'));
    await service.registrarEntrega(manager, entrega());
    expect(ledger.aplicar).toHaveBeenCalledTimes(1);
  });

  it('un error al leer tampoco rompe la entrega', async () => {
    const { service, manager, warehouses } = armar({});
    warehouses.asegurarPredeterminado.mockRejectedValueOnce(new Error('boom'));
    const r = await service.registrarEntrega(manager, entrega());
    expect(r).toEqual({ aplicadas: [], omitidas: [G1] });
  });
});
