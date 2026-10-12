import { BadRequestException, ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { OrderLookupService } from '../../order/lookup/order-lookup.service';
import type { StockLocationService } from '../../stock/application/stock-location.service';
import type { StockOnHandService } from '../../stock/application/stock-on-hand.service';
import type {
  OperacionDeStock,
  StockLedgerPort,
} from '../../stock/domain/ports/stock-ledger.port';
import { claveDeSaldo } from '../../stock/domain/stock-rules';
import {
  StockCondition,
  StockMovementReason,
} from '../../stock/domain/stock.enums';
import {
  CargaInvalidaError,
  TransicionDeCargaInvalidaError,
} from '../domain/errors/truck-load.errors';
import { TruckLoadStatus } from '../domain/truck-load.enums';
import { TruckLoadItem } from '../entities/truck-load-item.entity';
import { TruckLoad } from '../entities/truck-load.entity';
import { CancelTruckLoadUseCase } from './cancel-truck-load.use-case';
import { CloseTruckLoadUseCase } from './close-truck-load.use-case';
import { DepartTruckLoadUseCase } from './depart-truck-load.use-case';
import { ReturnTruckLoadUseCase } from './return-truck-load.use-case';

/** La primera operación que recibió el ledger de mentira. */
const primeraOperacion = (aplicar: jest.Mock): OperacionDeStock =>
  (aplicar.mock.calls as Array<[unknown, OperacionDeStock]>)[0][1];

const OPENED_AT = new Date('2026-10-12T10:00:00Z');
const CAMION = 'loc-camion';
const DEPOSITO = 'loc-deposito';

function carga(over: Partial<TruckLoad> = {}): TruckLoad {
  return {
    loadId: 'carga-1',
    number: 7,
    distributorId: 'dist',
    carId: 'car-1',
    deliveryId: 'chofer-1',
    originLocationId: DEPOSITO,
    status: TruckLoadStatus.RETURNED,
    openedAt: new Date('2026-10-12T10:00:00Z'),
    returnedAt: new Date('2026-10-12T18:00:00Z'),
    ...over,
  } as TruckLoad;
}

function renglon(over: Partial<TruckLoadItem> = {}): TruckLoadItem {
  return {
    gasCylinderId: 'g-10',
    loadedFull: 40,
    reloadedFull: 0,
    loadedEmpty: 0,
    declaredReturnFull: 10,
    declaredReturnEmpty: 30,
    ...over,
  } as TruckLoadItem;
}

/** Un DataSource cuyo `transaction` corre la función con un manager de mentira. */
function armar(cargaBloqueada: TruckLoad, items: TruckLoadItem[]) {
  const manager = {
    getRepository: jest.fn(() => ({
      createQueryBuilder: jest.fn(() => {
        const qb: Record<string, jest.Mock> = {};
        for (const m of ['setLock', 'where']) qb[m] = jest.fn(() => qb);
        qb.getOne = jest.fn().mockResolvedValue(cargaBloqueada);
        return qb;
      }),
    })),
    find: jest.fn().mockResolvedValue(items),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
    create: jest.fn((_e: unknown, x: unknown) => x),
    query: jest
      .fn()
      .mockResolvedValue([{ ahora: new Date('2026-10-12T19:00:00Z') }]),
  };
  const dataSource = {
    transaction: jest.fn((fn: (m: typeof manager) => Promise<unknown>) =>
      fn(manager),
    ),
  };
  return { manager, dataSource: dataSource as unknown as DataSource };
}

/** El chofer no tiene pedidos en curso. */
const sinPedidosEnCurso = {
  countEnCurso: jest.fn().mockResolvedValue(0),
} as unknown as OrderLookupService;

/** El camión no tiene nada en el stock. */
const camionVacio = { tiposConSaldo: jest.fn().mockResolvedValue([]) };

describe('casos de uso de la carga del camión', () => {
  describe('CloseTruckLoadUseCase', () => {
    let ledger: { aplicar: jest.Mock };
    let locations: { ubicacionDeVehiculo: jest.Mock };
    let onHand: {
      tiposConSaldo: jest.Mock;
      bloquearParaRendicion: jest.Mock;
      movimientosDelCamion: jest.Mock;
    };

    const caso = (cargaBloqueada: TruckLoad, items: TruckLoadItem[]) => {
      const { manager, dataSource } = armar(cargaBloqueada, items);
      return {
        manager,
        useCase: new CloseTruckLoadUseCase(
          dataSource,
          ledger as unknown as StockLedgerPort,
          locations as unknown as StockLocationService,
          onHand as unknown as StockOnHandService,
        ),
      };
    };
    const saldos = (full: number, empty: number) =>
      new Map([
        [claveDeSaldo(CAMION, 'g-10', StockCondition.FULL), full],
        [claveDeSaldo(CAMION, 'g-10', StockCondition.EMPTY), empty],
      ]);

    beforeEach(() => {
      ledger = {
        aplicar: jest.fn().mockResolvedValue({ batchId: 'b', movementIds: [] }),
      };
      locations = {
        ubicacionDeVehiculo: jest
          .fn()
          .mockResolvedValue({ locationId: CAMION }),
      };
      onHand = {
        tiposConSaldo: jest.fn().mockResolvedValue(['g-10']),
        bloquearParaRendicion: jest.fn().mockResolvedValue(saldos(10, 30)),
        // Desde la apertura: lo entregado; desde que declaró la vuelta: nada.
        movimientosDelCamion: jest.fn((_m: unknown, _l: string, desde: Date) =>
          Promise.resolve(
            desde.getTime() === OPENED_AT.getTime()
              ? [
                  {
                    gasCylinderId: 'g-10',
                    deliveredFull: 30,
                    collectedEmpty: 30,
                  },
                ]
              : [],
          ),
        ),
      };
    });

    it('sin diferencia cierra "closed", devuelve lo declarado y congela las cifras', async () => {
      const { useCase, manager } = caso(carga(), [renglon()]);

      await useCase.execute('carga-1', {}, 'dist', 'admin');

      const op = primeraOperacion(ledger.aplicar);
      expect(op.movimientos.map((m) => m.reason)).toEqual([
        StockMovementReason.TRUCK_RETURN,
        StockMovementReason.TRUCK_RETURN,
      ]);
      const guardada = manager.save.mock.calls
        .map((c): unknown => c[0])
        .find(
          (x): x is TruckLoad =>
            (x as TruckLoad).status !== undefined && !Array.isArray(x),
        );
      expect(guardada?.status).toBe(TruckLoadStatus.CLOSED);
      expect(guardada?.differenceNote).toBeNull();
      const items = manager.save.mock.calls[0][0] as TruckLoadItem[];
      expect(items[0]).toMatchObject({
        deliveredFull: 30,
        collectedEmpty: 30,
        expectedFull: 10,
        expectedEmpty: 30,
        differenceFull: 0,
        differenceEmpty: 0,
      });
    });

    it('lo entregado sale del libro y se descuenta del esperado (cargado + repuesto - entregado)', async () => {
      onHand.movimientosDelCamion.mockImplementation(
        (_m: unknown, _l: string, desde: Date) =>
          Promise.resolve(
            desde.getTime() === OPENED_AT.getTime()
              ? [
                  {
                    gasCylinderId: 'g-10',
                    deliveredFull: 25,
                    collectedEmpty: 25,
                  },
                ]
              : [],
          ),
      );
      onHand.bloquearParaRendicion.mockResolvedValue(saldos(15, 25));
      const { useCase, manager } = caso(carga(), [
        renglon({
          reloadedFull: 0,
          declaredReturnFull: 15,
          declaredReturnEmpty: 25,
        }),
      ]);

      await useCase.execute('carga-1', {}, 'dist', 'admin');

      const items = manager.save.mock.calls[0][0] as TruckLoadItem[];
      expect(items[0]).toMatchObject({
        expectedFull: 15,
        expectedEmpty: 25,
        differenceFull: 0,
      });
    });

    it('una entrega del camión DESPUÉS de declarar la vuelta: 409 y no cierra ni toca el ledger', async () => {
      onHand.movimientosDelCamion.mockImplementation(
        (_m: unknown, _l: string, desde: Date) =>
          Promise.resolve([
            {
              gasCylinderId: 'g-10',
              deliveredFull: desde.getTime() === OPENED_AT.getTime() ? 32 : 2,
              collectedEmpty: 2,
            },
          ]),
      );
      const { useCase, manager } = caso(carga(), [renglon()]);

      await expect(
        useCase.execute('carga-1', { differenceNote: 'x' }, 'dist', 'admin'),
      ).rejects.toThrow(
        /Se entregaron 2 garrafas del camión después de declarar la vuelta/,
      );
      expect(ledger.aplicar).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('las defectuosas del camión vuelven al depósito y el camión queda en cero', async () => {
      onHand.bloquearParaRendicion.mockResolvedValue(
        new Map([
          ...saldos(10, 30),
          [claveDeSaldo(CAMION, 'g-10', StockCondition.DEFECTIVE), 2],
        ]),
      );
      const { useCase } = caso(carga(), [renglon()]);

      await useCase.execute('carga-1', {}, 'dist', 'admin');

      const op = primeraOperacion(ledger.aplicar);
      expect(
        op.movimientos.find(
          (m) => m.from?.condition === StockCondition.DEFECTIVE,
        ),
      ).toMatchObject({
        quantity: 2,
        reason: StockMovementReason.TRUCK_RETURN,
        to: { locationId: DEPOSITO, condition: StockCondition.DEFECTIVE },
      });
    });

    it('con diferencia y sin nota: 400 y NO toca el ledger', async () => {
      const { useCase } = caso(carga(), [renglon({ declaredReturnFull: 8 })]);

      await expect(
        useCase.execute('carga-1', {}, 'dist', 'admin'),
      ).rejects.toThrow(/indicá la nota de la diferencia/);
      expect(ledger.aplicar).not.toHaveBeenCalled();
    });

    it('con diferencia y nota: cierra "closed_with_difference", la merma sale por el ledger y la nota queda', async () => {
      const { useCase, manager } = caso(carga(), [
        renglon({ declaredReturnFull: 8 }),
      ]);

      await useCase.execute(
        'carga-1',
        { differenceNote: '  Se cayeron 2 en la ruta  ' },
        'dist',
        'admin',
      );

      const op = primeraOperacion(ledger.aplicar);
      expect(
        op.movimientos.find((m) => m.reason === StockMovementReason.SHRINKAGE)
          ?.quantity,
      ).toBe(2);
      const guardada = manager.save.mock.calls
        .map((c) => c[0] as TruckLoad)
        .find((x) => !Array.isArray(x) && x.status !== undefined);
      expect(guardada).toMatchObject({
        status: TruckLoadStatus.CLOSED_WITH_DIFFERENCE,
        differenceNote: 'Se cayeron 2 en la ruta',
        closedByUserId: 'admin',
      });
    });

    it('lo que el camión tiene y la carga no lista se rinde igual, con renglón propio', async () => {
      onHand.tiposConSaldo.mockResolvedValue(['g-10', 'g-extra']);
      onHand.bloquearParaRendicion.mockResolvedValue(
        new Map([
          ...saldos(10, 30),
          [claveDeSaldo(CAMION, 'g-extra', StockCondition.FULL), 4],
        ]),
      );
      const { useCase, manager } = caso(carga(), [renglon()]);

      await expect(
        useCase.execute('carga-1', {}, 'dist', 'admin'),
      ).rejects.toBeInstanceOf(CargaInvalidaError);

      await useCase.execute(
        'carga-1',
        { differenceNote: 'sobraba stock a mano' },
        'dist',
        'admin',
      );
      expect(onHand.bloquearParaRendicion).toHaveBeenLastCalledWith(
        manager,
        expect.objectContaining({ gasCylinderIds: ['g-10', 'g-extra'] }),
      );
    });

    it.each([
      TruckLoadStatus.LOADING,
      TruckLoadStatus.ON_ROUTE,
      TruckLoadStatus.CLOSED,
      TruckLoadStatus.CLOSED_WITH_DIFFERENCE,
      TruckLoadStatus.CANCELLED,
    ])('una carga %s no se cierra (sólo la devuelta)', async (status) => {
      const { useCase } = caso(carga({ status }), [renglon()]);

      await expect(
        useCase.execute('carga-1', {}, 'dist', 'admin'),
      ).rejects.toBeInstanceOf(TransicionDeCargaInvalidaError);
      expect(ledger.aplicar).not.toHaveBeenCalled();
    });
  });

  describe('DepartTruckLoadUseCase', () => {
    it('sale con lo cargado: llenas y vacías del depósito al camión, y queda en ruta', async () => {
      const ledger = {
        aplicar: jest.fn().mockResolvedValue({ batchId: 'b', movementIds: [] }),
      };
      const locations = {
        ubicacionDeVehiculo: jest
          .fn()
          .mockResolvedValue({ locationId: CAMION }),
      };
      const c = carga({ status: TruckLoadStatus.LOADING });
      const { dataSource, manager } = armar(c, [
        renglon({ loadedFull: 40, loadedEmpty: 5 }),
      ]);

      await new DepartTruckLoadUseCase(
        dataSource,
        ledger as unknown as StockLedgerPort,
        locations as unknown as StockLocationService,
        camionVacio as unknown as StockOnHandService,
      ).execute('carga-1', 'dist', 'admin', undefined);

      const op = primeraOperacion(ledger.aplicar);
      expect(op.movimientos).toHaveLength(2);
      expect(
        op.movimientos.every(
          (m) => m.reason === StockMovementReason.TRUCK_LOAD,
        ),
      ).toBe(true);
      expect(op.movimientos.every((m) => m.from?.locationId === DEPOSITO)).toBe(
        true,
      );
      expect(c.status).toBe(TruckLoadStatus.ON_ROUTE);
      expect(c.departedAt).toBeInstanceOf(Date);
      expect(manager.save).toHaveBeenCalledWith(c);
    });

    it('un camión que todavía tiene garrafas en el stock no sale hasta devolverlas', async () => {
      const ledger = { aplicar: jest.fn() };
      const { dataSource } = armar(carga({ status: TruckLoadStatus.LOADING }), [
        renglon(),
      ]);

      await expect(
        new DepartTruckLoadUseCase(
          dataSource,
          ledger as unknown as StockLedgerPort,
          {
            ubicacionDeVehiculo: jest
              .fn()
              .mockResolvedValue({ locationId: CAMION }),
          } as unknown as StockLocationService,
          {
            tiposConSaldo: jest.fn().mockResolvedValue(['g-10']),
          } as unknown as StockOnHandService,
        ).execute('carga-1', 'dist', 'admin', undefined),
      ).rejects.toThrow(/todavía tiene garrafas en el stock/);
      expect(ledger.aplicar).not.toHaveBeenCalled();
    });

    it('un chofer no confirma la salida de la carga de otro (404, no se revela)', async () => {
      const ledger = { aplicar: jest.fn() };
      const { dataSource } = armar(carga({ status: TruckLoadStatus.LOADING }), [
        renglon(),
      ]);

      await expect(
        new DepartTruckLoadUseCase(
          dataSource,
          ledger as unknown as StockLedgerPort,
          { ubicacionDeVehiculo: jest.fn() } as unknown as StockLocationService,
          camionVacio as unknown as StockOnHandService,
        ).execute('carga-1', 'dist', 'u', 'otro-chofer'),
      ).rejects.toThrow(/no encontrada/);
      expect(ledger.aplicar).not.toHaveBeenCalled();
    });

    it('una carga sin garrafas no sale', async () => {
      const ledger = { aplicar: jest.fn() };
      const { dataSource } = armar(carga({ status: TruckLoadStatus.LOADING }), [
        renglon({ loadedFull: 0, loadedEmpty: 0 }),
      ]);

      await expect(
        new DepartTruckLoadUseCase(
          dataSource,
          ledger as unknown as StockLedgerPort,
          { ubicacionDeVehiculo: jest.fn() } as unknown as StockLocationService,
          camionVacio as unknown as StockOnHandService,
        ).execute('carga-1', 'dist', 'admin', undefined),
      ).rejects.toThrow(/no tiene garrafas/);
      expect(ledger.aplicar).not.toHaveBeenCalled();
    });

    it('una carga que ya salió no vuelve a mover stock', async () => {
      const ledger = { aplicar: jest.fn() };
      const { dataSource } = armar(
        carga({ status: TruckLoadStatus.ON_ROUTE }),
        [renglon()],
      );

      await expect(
        new DepartTruckLoadUseCase(
          dataSource,
          ledger as unknown as StockLedgerPort,
          { ubicacionDeVehiculo: jest.fn() } as unknown as StockLocationService,
          camionVacio as unknown as StockOnHandService,
        ).execute('carga-1', 'dist', 'admin', undefined),
      ).rejects.toBeInstanceOf(TransicionDeCargaInvalidaError);
      expect(ledger.aplicar).not.toHaveBeenCalled();
    });
  });

  describe('ReturnTruckLoadUseCase', () => {
    it('exige declarar todas las garrafas y rechaza las ajenas a la carga', async () => {
      const c = carga({ status: TruckLoadStatus.ON_ROUTE });
      const { dataSource } = armar(c, [
        renglon(),
        renglon({ gasCylinderId: 'g-5' }),
      ]);
      const uc = new ReturnTruckLoadUseCase(dataSource, sinPedidosEnCurso);

      await expect(
        uc.execute(
          'carga-1',
          {
            items: [
              { gasCylinderId: 'g-10', declaredFull: 1, declaredEmpty: 1 },
            ],
          },
          'dist',
          undefined,
        ),
      ).rejects.toThrow(/Falta declarar 1/);
      await expect(
        uc.execute(
          'carga-1',
          {
            items: [
              { gasCylinderId: 'g-otra', declaredFull: 1, declaredEmpty: 1 },
            ],
          },
          'dist',
          undefined,
        ),
      ).rejects.toThrow(/no es de esta carga/);
    });

    it('guarda lo declarado y pasa a "returned"; se puede volver a declarar', async () => {
      const c = carga({ status: TruckLoadStatus.ON_ROUTE });
      const item = renglon({
        declaredReturnFull: null,
        declaredReturnEmpty: null,
      });
      const { dataSource } = armar(c, [item]);
      const uc = new ReturnTruckLoadUseCase(dataSource, sinPedidosEnCurso);

      await uc.execute(
        'carga-1',
        {
          items: [
            { gasCylinderId: 'g-10', declaredFull: 9, declaredEmpty: 31 },
          ],
        },
        'dist',
        undefined,
      );
      expect(item).toMatchObject({
        declaredReturnFull: 9,
        declaredReturnEmpty: 31,
      });
      expect(c.status).toBe(TruckLoadStatus.RETURNED);

      await uc.execute(
        'carga-1',
        {
          items: [
            { gasCylinderId: 'g-10', declaredFull: 10, declaredEmpty: 30 },
          ],
        },
        'dist',
        undefined,
      );
      expect(item.declaredReturnFull).toBe(10);
    });

    it('con pedidos en curso no se declara la vuelta: 409 y no cambia nada', async () => {
      const c = carga({ status: TruckLoadStatus.ON_ROUTE });
      const item = renglon({
        declaredReturnFull: null,
        declaredReturnEmpty: null,
      });
      const { dataSource } = armar(c, [item]);
      const uc = new ReturnTruckLoadUseCase(dataSource, {
        countEnCurso: jest.fn().mockResolvedValue(2),
      } as unknown as OrderLookupService);

      await expect(
        uc.execute(
          'carga-1',
          {
            items: [
              { gasCylinderId: 'g-10', declaredFull: 9, declaredEmpty: 31 },
            ],
          },
          'dist',
          undefined,
        ),
      ).rejects.toThrow(
        'Tenés 2 pedidos en curso: entregalos o liberalos antes de volver',
      );
      expect(c.status).toBe(TruckLoadStatus.ON_ROUTE);
      expect(item.declaredReturnFull).toBeNull();
    });

    it('una carga cerrada no se vuelve a declarar', async () => {
      const { dataSource } = armar(carga({ status: TruckLoadStatus.CLOSED }), [
        renglon(),
      ]);

      await expect(
        new ReturnTruckLoadUseCase(dataSource, sinPedidosEnCurso).execute(
          'carga-1',
          {
            items: [
              { gasCylinderId: 'g-10', declaredFull: 1, declaredEmpty: 1 },
            ],
          },
          'dist',
          undefined,
        ),
      ).rejects.toBeInstanceOf(TransicionDeCargaInvalidaError);
    });
  });

  describe('CancelTruckLoadUseCase', () => {
    it('cancela sólo una carga que no salió, con el motivo', async () => {
      const c = carga({ status: TruckLoadStatus.LOADING });
      const { dataSource } = armar(c, []);

      await new CancelTruckLoadUseCase(dataSource).execute(
        'carga-1',
        'No salió',
        'dist',
        'admin',
      );

      expect(c).toMatchObject({
        status: TruckLoadStatus.CANCELLED,
        cancelReason: 'No salió',
      });
    });

    it.each([
      TruckLoadStatus.ON_ROUTE,
      TruckLoadStatus.RETURNED,
      TruckLoadStatus.CLOSED,
    ])('una carga %s no se cancela', async (status) => {
      const { dataSource } = armar(carga({ status }), []);

      await expect(
        new CancelTruckLoadUseCase(dataSource).execute(
          'carga-1',
          'x',
          'dist',
          'admin',
        ),
      ).rejects.toBeInstanceOf(TransicionDeCargaInvalidaError);
    });
  });

  it('los errores HTTP son los esperados', () => {
    expect(new BadRequestException('x')).toBeInstanceOf(BadRequestException);
    expect(new ConflictException('x')).toBeInstanceOf(ConflictException);
  });
});
