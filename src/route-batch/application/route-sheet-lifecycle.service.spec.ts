import { EntityManager } from 'typeorm';
import { DocumentSequenceService } from '../../document-sequence/document-sequence.service';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import { RouteBatchStop } from '../../order/entities/route-batch-stop.entity';
import { RoutePlanStatus } from '../../order/entities/route-plan.entity';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { instanteDelDia } from '../domain/route-sheet-rules';
import {
  PedidoDeHoja,
  RouteSheetDataService,
} from './route-sheet-data.service';
import { RouteSheetLifecycleService } from './route-sheet-lifecycle.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { RouteSheetWriter } from './route-sheet-writer.service';
import {
  DEPOSITO,
  DIA,
  DIST,
  PARAMS,
  calculadora,
  hoja,
  pedido,
  plan,
} from './route-sheet.fixtures';

interface Opciones {
  sheet?: RouteBatch;
  pedidos?: PedidoDeHoja[];
  chofer?: { available: boolean } | null;
  vehiculo?: {
    available: boolean;
    capacityKg: number | null;
    capacityUnits: number | null;
  } | null;
  ocupados?: { deliveryIds: string[]; carIds: string[] };
}

function armar(o: Opciones = {}) {
  const sheet = o.sheet ?? hoja();
  const pedidos = o.pedidos ?? [pedido('o1'), pedido('o2')];
  const manager = {
    save: jest.fn((x: unknown) => Promise.resolve(x)),
    query: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({}),
    findOne: jest.fn().mockResolvedValue(plan()),
  };
  const locks = {
    conHojas: jest.fn(
      (
        _d: string,
        _p: unknown,
        fn: (m: EntityManager, h: RouteBatch[]) => unknown,
      ) => fn(manager as unknown as EntityManager, [sheet]),
    ),
  };
  const writer = {
    parametros: jest.fn().mockResolvedValue(PARAMS),
    recalcular: jest.fn(async () => ({
      pedidos,
      orden: pedidos.map((p) => p.orderId),
      startMs: instanteDelDia(DIA, '07:30'),
      escenario: await calculadora().escenario(
        pedidos,
        DEPOSITO,
        instanteDelDia(DIA, '07:30'),
        PARAMS,
      ),
    })),
    apagarTodas: jest.fn().mockResolvedValue(undefined),
  };
  const data = {
    choferes: jest
      .fn()
      .mockResolvedValue(
        o.chofer === null
          ? []
          : [{ deliveryId: 'chofer-1', available: true, ...o.chofer }],
      ),
    vehiculos: jest.fn().mockResolvedValue(
      o.vehiculo === null
        ? []
        : [
            {
              carId: 'auto-1',
              available: true,
              capacityKg: 500,
              capacityUnits: 30,
              ...o.vehiculo,
            },
          ],
    ),
    ocupadosDelDia: jest.fn().mockResolvedValue({
      deliveryIds: new Set(o.ocupados?.deliveryIds ?? []),
      carIds: new Set(o.ocupados?.carIds ?? []),
    }),
  };
  const sequence = { siguienteNumero: jest.fn().mockResolvedValue(41) };
  const svc = new RouteSheetLifecycleService(
    locks as unknown as RouteSheetLocks,
    writer as unknown as RouteSheetWriter,
    data as unknown as RouteSheetDataService,
    sequence as unknown as DocumentSequenceService,
  );
  return { svc, sheet, manager, locks, writer, data, sequence };
}

describe('RouteSheetLifecycleService', () => {
  describe('confirmar', () => {
    it('numera, congela la ETA prometida y deja quién confirmó; no asigna los pedidos', async () => {
      const { svc, sheet, manager, locks, sequence } = armar();
      await svc.confirmar(DIST, 'hoja-1', { version: 3 }, 'u1');
      expect((locks.conHojas.mock.calls as unknown[][])[0][1]).toEqual([
        { id: 'hoja-1', version: 3 },
      ]);
      expect(sequence.siguienteNumero).toHaveBeenCalledWith(
        manager,
        DIST,
        'route_sheet',
      );
      expect(sheet).toMatchObject({
        status: 'confirmed',
        number: 41,
        confirmedByUserId: 'u1',
      });
      expect(sheet.confirmedAt).toBeInstanceOf(Date);
      expect((manager.query.mock.calls as unknown[][])[0][0]).toContain(
        '"planned_eta_at" = "eta_at"',
      );
      expect((manager.query.mock.calls as unknown[][])[0][1]).toEqual([
        'hoja-1',
      ]);
    });

    it('una hoja que ya tenía número (reabierta) lo conserva', async () => {
      const { svc, sheet, sequence } = armar({ sheet: hoja({ number: 7 }) });
      await svc.confirmar(DIST, 'hoja-1', { version: 3 }, 'u1');
      expect(sheet.number).toBe(7);
      expect(sequence.siguienteNumero).not.toHaveBeenCalled();
    });

    it('409 ROUTE_SHEET_NOT_EDITABLE si no es un borrador', async () => {
      const { svc } = armar({
        sheet: hoja({ status: RouteBatchStatus.CONFIRMED }),
      });
      await expect(
        svc.confirmar(DIST, 'hoja-1', { version: 3 }, 'u1'),
      ).rejects.toMatchObject({
        response: { code: 'ROUTE_SHEET_NOT_EDITABLE' },
      });
    });

    it('409 con violaciones: chofer y vehículo ocupados o no disponibles, capacidad y paradas fuera de franja', async () => {
      const { svc, sheet } = armar({
        pedidos: [
          pedido('o1', {
            weightKg: 300,
            units: 20,
            slotStartMs: instanteDelDia(DIA, '07:00'),
            slotEndMs: instanteDelDia(DIA, '07:31'),
          }),
          pedido('o2', { weightKg: 300, units: 20 }),
        ],
        chofer: { available: false },
        vehiculo: { available: false, capacityKg: 500, capacityUnits: 30 },
        ocupados: { deliveryIds: ['chofer-1'], carIds: ['auto-1'] },
      });
      const e = (await svc
        .confirmar(DIST, 'hoja-1', { version: 3 }, 'u1')
        .catch((x: unknown) => x)) as {
        getResponse(): {
          code: string;
          violations: Array<{ code: string; orderIds?: string[] }>;
        };
      };
      expect(e.getResponse().code).toBe('ROUTE_SHEET_NOT_CONFIRMABLE');
      expect(
        e
          .getResponse()
          .violations.map((v) => v.code)
          .sort(),
      ).toEqual(
        [
          'capacity_kg',
          'capacity_units',
          'car_taken',
          'car_unavailable',
          'driver_taken',
          'driver_unavailable',
          'late_stops',
        ].sort(),
      );
      expect(
        e.getResponse().violations.find((v) => v.code === 'late_stops')
          ?.orderIds,
      ).toEqual(['o1']);
      expect(sheet.status).toBe('draft');
    });

    it('409 stops_not_plannable si una parada tiene el pedido cancelado (o ya no se ve), aun aceptando las tardes', async () => {
      const { svc, sheet, writer } = armar({
        pedidos: [pedido('o1', { status: 'cancelled' }), pedido('o2')],
      });
      writer.recalcular.mockImplementationOnce(async () => {
        const pedidos = [pedido('o1', { status: 'cancelled' }), pedido('o2')];
        return {
          pedidos,
          orden: ['o1', 'o2', 'fantasma'],
          startMs: instanteDelDia(DIA, '07:30'),
          escenario: await calculadora().escenario(
            pedidos,
            DEPOSITO,
            instanteDelDia(DIA, '07:30'),
            PARAMS,
          ),
        };
      });
      const e = (await svc
        .confirmar(DIST, 'hoja-1', { version: 3, acceptLateStops: true }, 'u1')
        .catch((x: unknown) => x)) as {
        getResponse(): {
          violations: Array<{ code: string; orderIds?: string[] }>;
        };
      };
      expect(e.getResponse().violations).toEqual([
        expect.objectContaining({
          code: 'stops_not_plannable',
          orderIds: ['o1', 'fantasma'],
        }),
      ]);
      expect(sheet.status).toBe('draft');
    });

    it('con acceptLateStops una parada tarde no impide confirmar', async () => {
      const { svc, sheet } = armar({
        pedidos: [
          pedido('o1', {
            slotStartMs: instanteDelDia(DIA, '07:00'),
            slotEndMs: instanteDelDia(DIA, '07:31'),
          }),
        ],
      });
      await svc.confirmar(
        DIST,
        'hoja-1',
        { version: 3, acceptLateStops: true },
        'u1',
      );
      expect(sheet.status).toBe('confirmed');
    });

    it('sin chofer, sin vehículo y sin paradas: las tres violaciones, sin consultar recursos', async () => {
      const { svc, data } = armar({
        sheet: hoja({ deliveryId: null, carId: null }),
        pedidos: [],
      });
      const e = (await svc
        .confirmar(DIST, 'hoja-1', { version: 3 }, 'u1')
        .catch((x: unknown) => x)) as {
        getResponse(): { violations: Array<{ code: string }> };
      };
      expect(e.getResponse().violations.map((v) => v.code)).toEqual([
        'driver_missing',
        'car_missing',
        'no_stops',
      ]);
      expect(data.choferes).not.toHaveBeenCalled();
      expect(data.vehiculos).not.toHaveBeenCalled();
    });

    it('chofer o vehículo que no existen (de otra distribuidora) cuentan como no disponibles', async () => {
      const { svc } = armar({ chofer: null, vehiculo: null });
      const e = (await svc
        .confirmar(DIST, 'hoja-1', { version: 3 }, 'u1')
        .catch((x: unknown) => x)) as {
        getResponse(): { violations: Array<{ code: string }> };
      };
      expect(e.getResponse().violations.map((v) => v.code)).toEqual([
        'driver_unavailable',
        'car_unavailable',
      ]);
    });
  });

  describe('reabrir', () => {
    it('vuelve a borrador, borra la confirmación y la ETA prometida', async () => {
      const { svc, sheet, manager } = armar({
        sheet: hoja({
          status: RouteBatchStatus.CONFIRMED,
          confirmedAt: new Date(),
          confirmedByUserId: 'u1',
        }),
      });
      await svc.reabrir(DIST, 'hoja-1', 4);
      expect(sheet).toMatchObject({
        status: 'draft',
        confirmedAt: null,
        confirmedByUserId: null,
      });
      expect(sheet.editedAt).toBeInstanceOf(Date);
      expect(manager.update).toHaveBeenCalledWith(
        RouteBatchStop,
        { batchId: 'hoja-1', active: true },
        { plannedEtaAt: null },
      );
    });

    it('409 si no está confirmada y 409 ROUTE_PLAN_CLOSED si el día ya cerró', async () => {
      await expect(
        armar().svc.reabrir(DIST, 'hoja-1', 4),
      ).rejects.toMatchObject({
        response: { code: 'ROUTE_SHEET_NOT_EDITABLE' },
      });
      const cerrado = armar({
        sheet: hoja({ status: RouteBatchStatus.CONFIRMED }),
      });
      cerrado.manager.findOne.mockResolvedValueOnce(
        plan({ status: RoutePlanStatus.CLOSED }),
      );
      await expect(
        cerrado.svc.reabrir(DIST, 'hoja-1', 4),
      ).rejects.toMatchObject({
        response: { code: 'ROUTE_PLAN_CLOSED' },
      });
      expect(cerrado.sheet.status).toBe('confirmed');
    });
  });

  describe('cancelar', () => {
    it.each([RouteBatchStatus.DRAFT, RouteBatchStatus.CONFIRMED])(
      'una hoja %s se cancela: paradas afuera (admin) y queda dissolved',
      async (status) => {
        const { svc, sheet, writer, manager } = armar({
          sheet: hoja({ status }),
        });
        await svc.cancelar(DIST, 'hoja-1', 3);
        expect(writer.apagarTodas).toHaveBeenCalledWith(
          manager,
          'hoja-1',
          'admin',
        );
        expect(sheet).toMatchObject({
          status: 'dissolved',
          closeReason: 'admin',
        });
      },
    );

    it('409 si ya se inició o se cerró', async () => {
      const { svc, writer } = armar({
        sheet: hoja({ status: RouteBatchStatus.DISSOLVED }),
      });
      await expect(svc.cancelar(DIST, 'hoja-1', 3)).rejects.toMatchObject({
        response: { code: 'ROUTE_SHEET_NOT_EDITABLE' },
      });
      expect(writer.apagarTodas).not.toHaveBeenCalled();
    });
  });
});
