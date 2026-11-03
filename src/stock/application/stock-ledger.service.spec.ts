import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import {
  LoteNoEncontradoError,
  OperacionDeStockInvalidaError,
  StockInsuficienteError,
  UbicacionNoEncontradaError,
} from '../domain/errors/stock.errors';
import { MovimientoDeStock } from '../domain/ports/stock-ledger.port';
import {
  StockCondition as Cond,
  StockMovementReason as Razon,
  StockReferenceType,
} from '../domain/stock.enums';
import { StockMovement } from '../entities/stock-movement.entity';
import { StockLedgerService } from './stock-ledger.service';

const RELOJ_DE_LA_BASE = new Date('2026-10-12T15:00:00.000Z');
const DIST = 'dddddddd-0000-4000-8000-000000000001';
const L1 = '00000000-0000-4000-8000-000000000001';
const L2 = '00000000-0000-4000-8000-000000000002';
const G1 = '10000000-0000-4000-8000-000000000001';

interface Escenario {
  /** Saldos actuales por `ubicación|garrafa|condición`. */
  saldos?: Record<string, number>;
  /** Ubicaciones que existen en la distribuidora. */
  ubicaciones?: string[];
  /** Depósitos vigentes (los que no están acá están dados de baja). */
  depositosVigentes?: string[];
  garrafas?: string[];
  originales?: Partial<StockMovement>[];
  yaContraasentados?: string[];
  inactivas?: string[];
  vehiculosDeBaja?: string[];
}

function armar(esc: Escenario = {}) {
  const llamadas: string[] = [];
  const saldos = esc.saldos ?? {};
  const ubicaciones = esc.ubicaciones ?? [L1, L2];
  const insertados: Array<Record<string, unknown>> = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    if (sql.includes('clock_timestamp()')) {
      llamadas.push('reloj');
      return Promise.resolve([{ ahora: RELOJ_DE_LA_BASE }]);
    }
    if (sql.includes('FOR KEY SHARE')) {
      llamadas.push('lock-garrafa');
      return Promise.resolve([]);
    }
    if (sql.includes('FROM "stock_location" l')) {
      llamadas.push('ubicaciones');
      return Promise.resolve(
        ubicaciones.map((id) => ({
          location_id: id,
          warehouse_id: `w-${id}`,
          label: `Depósito ${id.slice(-1)}`,
          inactivo: (esc.inactivas ?? []).includes(id),
          vehiculo_de_baja: (esc.vehiculosDeBaja ?? []).includes(id),
        })),
      );
    }
    if (sql.includes('FROM "warehouse"')) {
      llamadas.push('lock-deposito');
      const vigentes =
        esc.depositosVigentes ?? ubicaciones.map((u) => `w-${u}`);
      return Promise.resolve(vigentes.map((w) => ({ warehouse_id: w })));
    }
    if (sql.includes('FROM "gas_cylinder"')) {
      llamadas.push('garrafas');
      return Promise.resolve(
        (esc.garrafas ?? [G1]).map((id) => ({
          gas_cylinder_id: id,
          type: '10kg',
        })),
      );
    }
    if (sql.includes('INSERT INTO "stock_balance"')) {
      llamadas.push('asegurar-saldos');
      return Promise.resolve([]);
    }
    if (sql.includes('FOR UPDATE OF b')) {
      llamadas.push('lock-saldos');
      const [locs, gars, conds] = params as [string[], string[], string[]];
      return Promise.resolve(
        locs
          .map((l, i) => ({
            location_id: l,
            gas_cylinder_id: gars[i],
            condition: conds[i],
            quantity: saldos[`${l}|${gars[i]}|${conds[i]}`],
          }))
          .filter((f) => f.quantity !== undefined),
      );
    }
    if (sql.includes('INSERT INTO "stock_movement"')) {
      llamadas.push('insert-movimientos');
      const CLAVES = [
        'distributorId',
        'gasCylinderId',
        'batchId',
        'quantity',
        'fromLocationId',
        'fromCondition',
        'toLocationId',
        'toCondition',
        'reason',
        'referenceType',
        'referenceId',
        'reversedMovementId',
        'notes',
        'actorUserId',
        'occurredAt',
      ];
      for (let i = 0; i < params.length; i += CLAVES.length) {
        insertados.push(
          Object.fromEntries(
            CLAVES.map((c, j) => [c, params[i + j]]),
          ) as Record<string, unknown>,
        );
      }
      return Promise.resolve(
        insertados.map((_, i) => ({ movement_id: `mov-${i}` })),
      );
    }
    if (sql.includes('UPDATE "stock_balance"')) {
      llamadas.push('update-saldos');
      return Promise.resolve([]);
    }
    if (sql.includes('"reversed_movement_id" = ANY')) {
      llamadas.push('ya-contraasentados');
      return Promise.resolve(
        (esc.yaContraasentados ?? []).map((id) => ({
          reversed_movement_id: id,
        })),
      );
    }
    throw new Error(`SQL no esperado: ${sql}`);
  });
  const manager = {
    queryRunner: { isTransactionActive: true },
    query,
    find: jest.fn().mockResolvedValue(esc.originales ?? []),
  } as unknown as EntityManager;
  const gasCylinders = {
    ajustarVendible: jest.fn(() => {
      llamadas.push('vendible');
      return Promise.resolve([] as Array<{ type: string; faltante: number }>);
    }),
  };
  const service = new StockLedgerService(
    gasCylinders as unknown as GasCylinderService,
  );
  return { service, manager, query, llamadas, insertados, gasCylinders };
}

const transferencia = (quantity = 5): MovimientoDeStock => ({
  gasCylinderId: G1,
  quantity,
  from: { locationId: L1, condition: Cond.FULL },
  to: { locationId: L2, condition: Cond.FULL },
  reason: Razon.TRANSFER,
});

const entradaDeLlenas = (quantity = 5): MovimientoDeStock => ({
  gasCylinderId: G1,
  quantity,
  from: null,
  to: { locationId: L1, condition: Cond.FULL },
  reason: Razon.ADJUSTMENT,
});

const op = (movimientos: MovimientoDeStock[]) => ({
  distributorId: DIST,
  referenceType: StockReferenceType.TRANSFER,
  referenceId: null,
  actorUserId: 'u1',
  movimientos,
});

describe('StockLedgerService.aplicar', () => {
  it('es un error de programación llamarlo sin transacción', async () => {
    const { service, manager } = armar();
    (
      manager.queryRunner as { isTransactionActive: boolean }
    ).isTransactionActive = false;
    await expect(
      service.aplicar(manager, op([transferencia()])),
    ).rejects.toThrow(/dentro de una transacción/);
  });

  it('rechaza una operación sin movimientos o con un movimiento mal formado, sin tocar la base', async () => {
    const { service, manager, query } = armar();
    await expect(service.aplicar(manager, op([]))).rejects.toBeInstanceOf(
      OperacionDeStockInvalidaError,
    );
    await expect(
      service.aplicar(manager, op([transferencia(0)])),
    ).rejects.toBeInstanceOf(OperacionDeStockInvalidaError);
    expect(query).not.toHaveBeenCalled();
  });

  describe('no negativo', () => {
    it('no deja un saldo por debajo de cero: StockInsuficienteError con el detalle y sin escribir', async () => {
      const { service, manager, llamadas, insertados } = armar({
        saldos: { [`${L1}|${G1}|full`]: 3 },
      });
      const error = await service
        .aplicar(manager, op([transferencia(5)]))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StockInsuficienteError);
      expect((error as StockInsuficienteError).faltantes).toEqual([
        expect.objectContaining({
          locationId: L1,
          gasCylinderId: G1,
          condition: Cond.FULL,
          available: 3,
          requested: 5,
        }),
      ]);
      expect((error as Error).message).toMatch(
        /10kg llenas en Depósito 1 \(hay 3, se necesitan 5\)/,
      );
      expect(llamadas).not.toContain('update-saldos');
      expect(llamadas).not.toContain('insert-movimientos');
      expect(insertados).toHaveLength(0);
    });

    it('un saldo que no existe cuenta como cero', async () => {
      const { service, manager } = armar({ saldos: {} });
      await expect(
        service.aplicar(manager, op([transferencia(1)])),
      ).rejects.toMatchObject({
        faltantes: [expect.objectContaining({ available: 0, requested: 1 })],
      });
    });

    it('con exactamente el saldo alcanza (queda en cero, no negativo)', async () => {
      const { service, manager } = armar({
        saldos: { [`${L1}|${G1}|full`]: 5, [`${L2}|${G1}|full`]: 0 },
      });
      await expect(
        service.aplicar(manager, op([transferencia(5)])),
      ).resolves.toMatchObject({ movementIds: ['mov-0'] });
    });

    it('informa todos los faltantes de una vez', async () => {
      const { service, manager } = armar({ saldos: {} });
      const error = await service
        .aplicar(
          manager,
          op([
            transferencia(1),
            {
              ...transferencia(2),
              from: { locationId: L2, condition: Cond.EMPTY },
              to: null,
            },
          ]),
        )
        .catch((e: unknown) => e as StockInsuficienteError);
      expect((error as StockInsuficienteError).faltantes).toHaveLength(2);
    });
  });

  describe('orden de locks', () => {
    it('toma gas_cylinder (vendible) ANTES que stock_balance', async () => {
      const { service, manager, llamadas } = armar({
        saldos: { [`${L1}|${G1}|full`]: 0 },
      });
      await service.aplicar(manager, op([entradaDeLlenas()]));
      expect(llamadas.indexOf('vendible')).toBeGreaterThan(-1);
      expect(llamadas.indexOf('vendible')).toBeLessThan(
        llamadas.indexOf('lock-saldos'),
      );
      expect(llamadas.indexOf('lock-saldos')).toBeLessThan(
        llamadas.indexOf('update-saldos'),
      );
      expect(llamadas.indexOf('update-saldos')).toBeLessThan(
        llamadas.indexOf('insert-movimientos'),
      );
    });

    it('sin cambio de vendible (entrega, transferencia) igual bloquea gas_cylinder (KEY SHARE) ANTES que los saldos', async () => {
      const { service, manager, llamadas, gasCylinders } = armar({
        saldos: { [`${L1}|${G1}|full`]: 9 },
      });
      await service.aplicar(manager, op([transferencia(2)]));
      expect(gasCylinders.ajustarVendible).not.toHaveBeenCalled();
      expect(llamadas.indexOf('lock-garrafa')).toBeGreaterThan(-1);
      expect(llamadas.indexOf('lock-garrafa')).toBeLessThan(
        llamadas.indexOf('lock-saldos'),
      );
    });

    it('con cambio de vendible no baja a KEY SHARE: lo bloquea FOR UPDATE ajustarVendible', async () => {
      const { service, manager, llamadas } = armar();
      await service.aplicar(manager, op([entradaDeLlenas()]));
      expect(llamadas).not.toContain('lock-garrafa');
    });

    it('el lock de saldos pide el orden global (ubicación, tipo, condición)', async () => {
      const { service, manager, query } = armar({
        saldos: { [`${L1}|${G1}|full`]: 9, [`${L2}|${G1}|full`]: 0 },
      });
      await service.aplicar(manager, op([transferencia(2)]));
      const sql = query.mock.calls
        .map((c) => c[0])
        .find((s) => s.includes('FOR UPDATE OF b'));
      expect(sql).toMatch(
        /ORDER BY b\."location_id", b\."gas_cylinder_id", b\."condition"\s+FOR UPDATE OF b/,
      );
    });

    it('un depósito se toma con lock compartido para frenar su baja', async () => {
      const { service, manager, query } = armar({
        saldos: { [`${L1}|${G1}|full`]: 9 },
      });
      await service.aplicar(manager, op([transferencia(2)]));
      const sql = query.mock.calls
        .map((c) => c[0])
        .find((s) => s.includes('FROM "warehouse"'));
      expect(sql).toMatch(/FOR SHARE/);
    });
  });

  describe('vendible (D4)', () => {
    it('entrar llenas desde afuera suma el vendible lo mismo', async () => {
      const { service, manager, gasCylinders } = armar();
      await service.aplicar(manager, op([entradaDeLlenas(7)]));
      expect(gasCylinders.ajustarVendible).toHaveBeenCalledWith(
        manager,
        DIST,
        [{ gasCylinderId: G1, delta: 7 }],
        { recortarEnCero: true },
      );
    });

    it('una transferencia no toca el vendible', async () => {
      const { service, manager, gasCylinders } = armar({
        saldos: { [`${L1}|${G1}|full`]: 9 },
      });
      await service.aplicar(manager, op([transferencia(2)]));
      expect(gasCylinders.ajustarVendible).not.toHaveBeenCalled();
    });

    it("con vendible 'sin-cambio' (la entrega) no lo toca aunque salgan llenas", async () => {
      const { service, manager, gasCylinders } = armar({
        saldos: { [`${L1}|${G1}|full`]: 9 },
      });
      await service.aplicar(manager, {
        ...op([{ ...transferencia(2), to: null, reason: Razon.DELIVERY }]),
        vendible: 'sin-cambio',
      });
      expect(gasCylinders.ajustarVendible).not.toHaveBeenCalled();
    });

    it('pide recortar en cero: una pérdida física no se frena porque el vendible esté reservado', async () => {
      const { service, manager, gasCylinders, insertados } = armar({
        saldos: { [`${L1}|${G1}|full`]: 9 },
      });
      await service.aplicar(
        manager,
        op([{ ...transferencia(2), to: null, reason: Razon.SHRINKAGE }]),
      );
      expect(gasCylinders.ajustarVendible).toHaveBeenCalledWith(
        manager,
        DIST,
        [{ gasCylinderId: G1, delta: -2 }],
        { recortarEnCero: true },
      );
      expect(insertados).toHaveLength(1);
    });

    it('si el vendible se recortó, el movimiento se asienta igual y queda el aviso', async () => {
      const { service, manager, gasCylinders, insertados } = armar({
        saldos: { [`${L1}|${G1}|full`]: 9 },
      });
      gasCylinders.ajustarVendible.mockResolvedValueOnce([
        { type: '10kg', faltante: 2 },
      ]);
      const r = await service.aplicar(
        manager,
        op([{ ...transferencia(2), to: null, reason: Razon.SHRINKAGE }]),
      );
      expect(r.movementIds).toHaveLength(1);
      expect(insertados).toHaveLength(1);
    });
  });

  describe('reloj', () => {
    it('sin occurredAt el movimiento se fecha con el reloj de la base, no con el del proceso', async () => {
      const { service, manager, insertados } = armar({
        saldos: { [`${L1}|${G1}|full`]: 9 },
      });
      await service.aplicar(manager, op([transferencia(1)]));
      expect(insertados[0].occurredAt).toBe(RELOJ_DE_LA_BASE);
    });

    it('con occurredAt explícito lo respeta y no pregunta la hora', async () => {
      const { service, manager, insertados, llamadas } = armar({
        saldos: { [`${L1}|${G1}|full`]: 9 },
      });
      const fecha = new Date('2026-01-01T00:00:00Z');
      await service.aplicar(manager, {
        ...op([transferencia(1)]),
        occurredAt: fecha,
      });
      expect(insertados[0].occurredAt).toBe(fecha);
      expect(llamadas).not.toContain('reloj');
    });
  });

  describe('aislamiento por distribuidora', () => {
    it('una ubicación de otra distribuidora es 404', async () => {
      const { service, manager, llamadas } = armar({ ubicaciones: [L1] });
      await expect(
        service.aplicar(manager, op([transferencia()])),
      ).rejects.toBeInstanceOf(UbicacionNoEncontradaError);
      expect(llamadas).not.toContain('lock-saldos');
    });

    it('dice si la ubicación que falta es el origen o el destino, sin ids', async () => {
      const faltaDestino = armar({ ubicaciones: [L1] });
      await expect(
        faltaDestino.service.aplicar(
          faltaDestino.manager,
          op([transferencia()]),
        ),
      ).rejects.toThrow('Ubicación de destino no encontrada');

      const faltaOrigen = armar({ ubicaciones: [L2] });
      await expect(
        faltaOrigen.service.aplicar(faltaOrigen.manager, op([transferencia()])),
      ).rejects.toThrow('Ubicación de origen no encontrada');
    });

    it('una garrafa de otra distribuidora es 404', async () => {
      const { service, manager } = armar({ garrafas: [] });
      await expect(
        service.aplicar(manager, op([transferencia()])),
      ).rejects.toThrow('Garrafa no encontrada');
    });

    it('un depósito dado de baja no recibe ni entrega nada', async () => {
      const { service, manager } = armar({ depositosVigentes: [`w-${L1}`] });
      await expect(
        service.aplicar(manager, op([transferencia()])),
      ).rejects.toBeInstanceOf(UbicacionNoEncontradaError);
    });

    it('un depósito inactivo no recibe stock, pero sí puede entregar el que le queda', async () => {
      const recibe = armar({
        inactivas: [L2],
        saldos: { [`${L1}|${G1}|full`]: 9 },
      });
      await expect(
        recibe.service.aplicar(recibe.manager, op([transferencia(2)])),
      ).rejects.toThrow(/inactivo: no recibe stock/);
      const entrega = armar({
        inactivas: [L1],
        saldos: { [`${L1}|${G1}|full`]: 9, [`${L2}|${G1}|full`]: 0 },
      });
      await expect(
        entrega.service.aplicar(entrega.manager, op([transferencia(2)])),
      ).resolves.toBeDefined();
    });

    it('un vehículo dado de baja no recibe, pero con stock puede vaciarse hacia un depósito', async () => {
      const recibe = armar({
        vehiculosDeBaja: [L2],
        saldos: { [`${L1}|${G1}|full`]: 9 },
      });
      await expect(
        recibe.service.aplicar(recibe.manager, op([transferencia(2)])),
      ).rejects.toThrow(/dado de baja: no recibe stock/);
      const vacia = armar({
        vehiculosDeBaja: [L1],
        saldos: { [`${L1}|${G1}|full`]: 9, [`${L2}|${G1}|full`]: 0 },
      });
      await expect(
        vacia.service.aplicar(vacia.manager, op([transferencia(9)])),
      ).resolves.toBeDefined();
    });

    it('filtra las consultas por la distribuidora de la operación', async () => {
      const { service, manager, query } = armar({
        saldos: { [`${L1}|${G1}|full`]: 9 },
      });
      await service.aplicar(manager, op([transferencia(1)]));
      const conTenant = query.mock.calls.filter(
        (c) => c[0].includes('"distributor_id" = $2') && c[1]?.includes(DIST),
      );
      expect(conTenant).toHaveLength(2);
    });
  });

  it('inserta un movimiento por renglón con el mismo lote, la referencia y el actor', async () => {
    const { service, manager, insertados } = armar({
      saldos: { [`${L1}|${G1}|full`]: 9 },
    });
    const r = await service.aplicar(manager, {
      ...op([transferencia(2), transferencia(3)]),
      referenceId: 'ref-1',
      notes: 'nota',
    });
    expect(insertados).toHaveLength(2);
    expect(new Set(insertados.map((i) => i.batchId))).toEqual(
      new Set([r.batchId]),
    );
    expect(insertados[0]).toMatchObject({
      distributorId: DIST,
      gasCylinderId: G1,
      quantity: 2,
      fromLocationId: L1,
      fromCondition: Cond.FULL,
      toLocationId: L2,
      toCondition: Cond.FULL,
      reason: Razon.TRANSFER,
      referenceType: StockReferenceType.TRANSFER,
      referenceId: 'ref-1',
      actorUserId: 'u1',
      notes: 'nota',
      reversedMovementId: null,
    });
  });

  it('respeta el lote que le pasan', async () => {
    const { service, manager } = armar({ saldos: { [`${L1}|${G1}|full`]: 9 } });
    const r = await service.aplicar(manager, {
      ...op([transferencia(1)]),
      batchId: 'lote-fijo',
    });
    expect(r.batchId).toBe('lote-fijo');
  });
});

describe('StockLedgerService.contraasentar (corrección sin editar el libro)', () => {
  const original = (
    over: Partial<StockMovement> = {},
  ): Partial<StockMovement> => ({
    movementId: 'orig-1',
    distributorId: DIST,
    batchId: 'lote-1',
    gasCylinderId: G1,
    quantity: 4,
    fromLocationId: L1,
    fromCondition: Cond.FULL,
    toLocationId: L2,
    toCondition: Cond.FULL,
    reason: Razon.TRANSFER,
    referenceType: StockReferenceType.TRANSFER,
    referenceId: 'lote-1',
    ...over,
  });
  const args = {
    distributorId: DIST,
    batchId: 'lote-1',
    actorUserId: 'u1',
    notes: 'se cargó mal',
  };

  it('genera los movimientos inversos que apuntan a los originales', async () => {
    const { service, manager, insertados } = armar({
      originales: [original()],
      saldos: { [`${L2}|${G1}|full`]: 4, [`${L1}|${G1}|full`]: 0 },
    });
    await service.contraasentar(manager, args);
    expect(insertados).toEqual([
      expect.objectContaining({
        reason: Razon.REVERSAL,
        quantity: 4,
        fromLocationId: L2,
        fromCondition: Cond.FULL,
        toLocationId: L1,
        toCondition: Cond.FULL,
        reversedMovementId: 'orig-1',
        notes: 'se cargó mal',
        referenceType: StockReferenceType.TRANSFER,
        referenceId: 'lote-1',
      }),
    ]);
  });

  it('invierte también los extremos nulos (lo que entró desde afuera, sale)', async () => {
    const { service, manager, insertados } = armar({
      originales: [
        original({
          fromLocationId: null,
          fromCondition: null,
          reason: Razon.ADJUSTMENT,
        }),
      ],
      saldos: { [`${L2}|${G1}|full`]: 4 },
    });
    await service.contraasentar(manager, args);
    expect(insertados[0]).toMatchObject({
      fromLocationId: L2,
      toLocationId: null,
      toCondition: null,
    });
  });

  it('el vendible acompaña al contraasiento de un ajuste, pero no al de una entrega', async () => {
    const ajuste = armar({
      originales: [
        original({
          fromLocationId: null,
          fromCondition: null,
          reason: Razon.ADJUSTMENT,
        }),
      ],
      saldos: { [`${L2}|${G1}|full`]: 4 },
    });
    await ajuste.service.contraasentar(ajuste.manager, args);
    expect(ajuste.gasCylinders.ajustarVendible).toHaveBeenCalledWith(
      ajuste.manager,
      DIST,
      [{ gasCylinderId: G1, delta: -4 }],
      { recortarEnCero: true },
    );

    const entrega = armar({
      originales: [
        original({
          toLocationId: null,
          toCondition: null,
          reason: Razon.DELIVERY,
        }),
      ],
      saldos: {},
    });
    await entrega.service.contraasentar(entrega.manager, args);
    expect(entrega.gasCylinders.ajustarVendible).not.toHaveBeenCalled();
  });

  it('un lote inexistente (o de otra distribuidora) es 404', async () => {
    const { service, manager } = armar({ originales: [] });
    await expect(service.contraasentar(manager, args)).rejects.toBeInstanceOf(
      LoteNoEncontradoError,
    );
  });

  it('un contraasiento no se contraasienta', async () => {
    const { service, manager } = armar({
      originales: [original({ reason: Razon.REVERSAL })],
    });
    await expect(service.contraasentar(manager, args)).rejects.toThrow(
      /no se vuelve a contraasentar/,
    );
  });

  it('un lote ya contraasentado es 409 y no escribe', async () => {
    // Hay saldo de sobra: lo único que lo frena es que ya fue contraasentado.
    const { service, manager, insertados } = armar({
      originales: [original()],
      yaContraasentados: ['orig-1'],
      saldos: { [`${L2}|${G1}|full`]: 99 },
    });
    await expect(service.contraasentar(manager, args)).rejects.toThrow(
      /ya fue contraasentado/,
    );
    await expect(service.contraasentar(manager, args)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(insertados).toHaveLength(0);
  });

  it('si las garrafas ya no están donde estaban es 409, no 400', async () => {
    const { service, manager } = armar({
      originales: [original()],
      saldos: { [`${L2}|${G1}|full`]: 1 },
    });
    await expect(service.contraasentar(manager, args)).rejects.toThrow(
      /ya no están donde estaban/,
    );
    await expect(service.contraasentar(manager, args)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
