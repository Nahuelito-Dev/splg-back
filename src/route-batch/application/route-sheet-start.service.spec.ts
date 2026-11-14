import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { DeliveryService } from '../../delivery/delivery.service';
import { FleetDispatchLockService } from '../../fleet/fleet-dispatch-lock.service';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import {
  CargaAbiertaDelChofer,
  TruckLoadLookupService,
} from '../../truck-load/application/truck-load-lookup.service';
import { TruckLoadStatus } from '../../truck-load/domain/truck-load.enums';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { RouteSheetAssignmentService } from './route-sheet-assignment.service';
import { RouteSheetEtaService } from './route-sheet-eta.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { RouteSheetNotifier } from './route-sheet-notifier.service';
import { RouteSheetProgress } from './route-sheet-progress.service';
import { RouteSheetStartService } from './route-sheet-start.service';
import { RouteSheetWriter } from './route-sheet-writer.service';
import { DIST, hoja, parada } from './route-sheet.fixtures';

const HOY = diaArgentino();
const chofer = (over: Partial<Delivery> = {}) =>
  ({
    deliveryId: 'chofer-1',
    userId: 'u-chofer',
    distributorId: DIST,
    isEnabled: true,
    validated: true,
    notificationToken: 'tok',
    ...over,
  }) as Delivery;

const carga = (over: Partial<CargaAbiertaDelChofer> = {}) => ({
  loadId: 'carga-1',
  number: 7,
  status: TruckLoadStatus.ON_ROUTE,
  carId: 'auto-1',
  carPatent: 'AB123CD',
  fullOnTruck: new Map([['g10', 10]]),
  ...over,
});

const codigo = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (e) {
    return (e as { getResponse: () => { code?: string } }).getResponse().code;
  }
  return 'sin error';
};

function armar(
  o: {
    sheet?: RouteBatch;
    asignados?: string[];
    caidos?: string[];
    enUso?: { carId: string; patent: string | null } | null;
    motivos?: string[];
    carga?: ReturnType<typeof carga> | null;
    pedido?: Array<{ gasCylinderId: string; type: string; units: number }>;
    actor?: Delivery | null;
    mutex?: boolean;
  } = {},
) {
  const sheet =
    o.sheet ??
    hoja({
      status: RouteBatchStatus.CONFIRMED,
      planDate: HOY,
      confirmedAt: new Date(),
      assignedAt: new Date(),
    });
  const asignados = o.asignados ?? ['o1', 'o2'];
  const query = jest.fn((sql: string) => {
    if (sql.includes('"car_patent" AS "patent"')) {
      return Promise.resolve([{ patent: 'AB123CD' }]);
    }
    if (sql.includes('SUM(oi."quantity")')) {
      return Promise.resolve(
        o.pedido ?? [{ gasCylinderId: 'g10', type: '10 kg', units: 2 }],
      );
    }
    return Promise.resolve([]);
  });
  const save = jest.fn((h: RouteBatch) => Promise.resolve(h));
  const sheets = { findOne: jest.fn(() => Promise.resolve(sheet)) };
  let cola = Promise.resolve();
  const locks = {
    conCerrojo: jest.fn((_ids: string[], fn: () => Promise<unknown>) => {
      if (!o.mutex) return fn();
      const turno = cola.then(fn);
      cola = turno.then(
        () => undefined,
        () => undefined,
      );
      return turno;
    }),
    enTransaccion: jest.fn(
      (
        _d: string,
        _p: unknown,
        fn: (m: EntityManager, h: RouteBatch[]) => unknown,
      ) => fn({ save } as unknown as EntityManager, [sheet]),
    ),
  };
  const progress = {
    posicionDelChofer: jest.fn().mockResolvedValue(null),
    rehacer: jest.fn().mockResolvedValue({
      recorrido: { hechas: [], enCamino: null, pendientes: asignados },
      cola: asignados,
      etas: [],
      origen: 'warehouse',
    }),
  };
  const writer = {
    paradasActivas: jest
      .fn()
      .mockResolvedValue(asignados.map((id, i) => parada(id, i + 1))),
  };
  const asignacion = {
    asignarConCerrojoTomado: jest.fn().mockResolvedValue({
      sheetId: 'hoja-1',
      assignedOrderIds: asignados,
      droppedOrderIds: o.caidos ?? [],
      skipped: false,
    }),
  };
  const deliveries = {
    findOneByUserId: jest.fn(() =>
      o.actor === null
        ? Promise.reject(new NotFoundException('no'))
        : Promise.resolve(o.actor ?? chofer()),
    ),
    findById: jest.fn().mockResolvedValue(chofer()),
  };
  const fleet = {
    vehiculoEnUsoDelChofer: jest
      .fn()
      .mockResolvedValue(
        o.enUso === undefined
          ? { carId: 'auto-1', patent: 'AB123CD' }
          : o.enUso,
      ),
    motivosDeInhabilitacion: jest
      .fn()
      .mockResolvedValue([...(o.motivos ?? [])]),
  };
  const cargas = {
    cargaAbiertaDelChofer: jest
      .fn()
      .mockResolvedValue(o.carga === undefined ? carga() : o.carga),
  };
  const eta = {
    olvidarChofer: jest.fn().mockResolvedValue(undefined),
    avisarSalida: jest.fn().mockResolvedValue(asignados.length),
  };
  const notifier = { alChofer: jest.fn(), alPanel: jest.fn() };
  const svc = new RouteSheetStartService(
    { query, manager: {} } as unknown as DataSource,
    sheets as unknown as Repository<RouteBatch>,
    locks as unknown as RouteSheetLocks,
    progress as unknown as RouteSheetProgress,
    writer as unknown as RouteSheetWriter,
    asignacion as unknown as RouteSheetAssignmentService,
    deliveries as unknown as DeliveryService,
    fleet as unknown as FleetDispatchLockService,
    cargas as unknown as TruckLoadLookupService,
    eta as unknown as RouteSheetEtaService,
    notifier as unknown as RouteSheetNotifier,
  );
  return {
    svc,
    sheet,
    sheets,
    asignacion,
    progress,
    eta,
    notifier,
    save,
    deliveries,
  };
}

const COMO_CHOFER = { userId: 'u-chofer', esChofer: true };
const COMO_ADMIN = { userId: 'u-admin', esChofer: false };

describe('RouteSheetStartService.iniciar (Iniciar viaje)', () => {
  it('con la carga en la calle: la hoja pasa a en curso con la carga vinculada y se les avisa a todos los clientes', async () => {
    const t = armar();
    const r = await t.svc.iniciar(DIST, 'hoja-1', COMO_CHOFER, false);
    expect(r).toEqual({
      sheetId: 'hoja-1',
      alreadyStarted: false,
      assignedOrderIds: ['o1', 'o2'],
      droppedOrderIds: [],
      shortages: [],
      truckLoadId: 'carga-1',
      notifiedCustomers: 2,
    });
    expect(t.asignacion.asignarConCerrojoTomado).toHaveBeenCalledWith(
      DIST,
      'hoja-1',
      'u-chofer',
    );
    expect(t.sheet.status).toBe(RouteBatchStatus.ASSIGNED);
    expect(t.sheet.startedAt).toBeInstanceOf(Date);
    expect(t.sheet.truckLoadId).toBe('carga-1');
    expect(t.save).toHaveBeenCalledWith(t.sheet);
    expect(t.eta.avisarSalida).toHaveBeenCalledWith(
      DIST,
      'hoja-1',
      expect.objectContaining({ cola: ['o1', 'o2'] }),
      expect.any(Number),
      'u-chofer',
    );
    expect(t.notifier.alChofer).toHaveBeenCalledWith(
      'u-chofer',
      'route-sheet:started',
      { sheetId: 'hoja-1', orderIds: ['o1', 'o2'], droppedOrderIds: [] },
    );
    expect(t.notifier.alPanel).toHaveBeenCalledWith(
      DIST,
      'route-sheet:started',
      expect.objectContaining({ assignedOrders: 2 }),
    );
  });

  it('los pedidos que ya no estaban disponibles se informan (la asignación los sacó de la hoja)', async () => {
    const t = armar({ asignados: ['o1'], caidos: ['o2'] });
    const r = await t.svc.iniciar(DIST, 'hoja-1', COMO_CHOFER, false);
    expect(r.droppedOrderIds).toEqual(['o2']);
  });

  it('reintento: el viaje ya iniciado devuelve lo que hay, sin tocar nada', async () => {
    const t = armar({
      sheet: hoja({ status: RouteBatchStatus.ASSIGNED, truckLoadId: 'c9' }),
    });
    const r = await t.svc.iniciar(DIST, 'hoja-1', COMO_CHOFER, false);
    expect(r).toMatchObject({
      alreadyStarted: true,
      assignedOrderIds: ['o1', 'o2'],
      truckLoadId: 'c9',
      notifiedCustomers: 0,
    });
    expect(t.asignacion.asignarConCerrojoTomado).not.toHaveBeenCalled();
    expect(t.eta.avisarSalida).not.toHaveBeenCalled();
  });

  it('dos inicios a la vez: el segundo espera el cerrojo y ve el viaje iniciado (un solo aviso a los clientes)', async () => {
    const t = armar({ mutex: true });
    const [a, b] = await Promise.all([
      t.svc.iniciar(DIST, 'hoja-1', COMO_CHOFER, false),
      t.svc.iniciar(DIST, 'hoja-1', COMO_CHOFER, false),
    ]);
    expect([a.alreadyStarted, b.alreadyStarted].sort()).toEqual([false, true]);
    expect(t.eta.avisarSalida).toHaveBeenCalledTimes(1);
  });

  it('404: no existe, es de otro chofer, de otra distribuidora o el usuario no es chofer', async () => {
    const noExiste = armar();
    noExiste.sheets.findOne.mockResolvedValue(null as unknown as RouteBatch);
    expect(
      await codigo(noExiste.svc.iniciar(DIST, 'x', COMO_CHOFER, false)),
    ).toBe('ROUTE_SHEET_NOT_FOUND');
    for (const actor of [
      chofer({ deliveryId: 'chofer-2' }),
      chofer({ distributorId: 'otra' }),
      null,
    ]) {
      const t = armar({ actor });
      expect(
        await codigo(t.svc.iniciar(DIST, 'hoja-1', COMO_CHOFER, false)),
      ).toBe('ROUTE_SHEET_NOT_FOUND');
      expect(t.asignacion.asignarConCerrojoTomado).not.toHaveBeenCalled();
    }
  });

  it.each([
    [RouteBatchStatus.DRAFT, HOY, 'ROUTE_SHEET_NOT_STARTABLE'],
    [RouteBatchStatus.COMPLETED, HOY, 'ROUTE_SHEET_NOT_STARTABLE'],
    [RouteBatchStatus.CONFIRMED, '2099-01-01', 'ROUTE_SHEET_NOT_TODAY'],
  ])('409 en %s del %s: %s', async (status, planDate, esperado) => {
    const t = armar({ sheet: hoja({ status, planDate }) });
    expect(
      await codigo(t.svc.iniciar(DIST, 'hoja-1', COMO_CHOFER, false)),
    ).toBe(esperado);
    expect(t.asignacion.asignarConCerrojoTomado).not.toHaveBeenCalled();
  });

  it('el admin lo inicia en nombre del chofer; sin chofer en la hoja no se puede', async () => {
    const t = armar();
    await t.svc.iniciar(DIST, 'hoja-1', COMO_ADMIN, false);
    expect(t.deliveries.findById).toHaveBeenCalledWith('chofer-1');
    expect(t.deliveries.findOneByUserId).not.toHaveBeenCalled();
    const sin = armar({
      sheet: hoja({
        status: RouteBatchStatus.CONFIRMED,
        planDate: HOY,
        deliveryId: null,
      }),
    });
    expect(
      await codigo(sin.svc.iniciar(DIST, 'hoja-1', COMO_ADMIN, false)),
    ).toBe('ROUTE_SHEET_NOT_STARTABLE');
  });

  it('409 CAR_NOT_IN_USE (mensaje neutro, sirve para el chofer y el admin) o sin vehículo en uso', async () => {
    let error: ConflictException | undefined;
    await armar({ enUso: { carId: 'auto-9', patent: 'ZZ999ZZ' } })
      .svc.iniciar(DIST, 'hoja-1', COMO_ADMIN, false)
      .catch((e: ConflictException) => (error = e));
    expect(error?.getResponse()).toMatchObject({
      code: 'ROUTE_SHEET_CAR_NOT_IN_USE',
      sheetCarPatent: 'AB123CD',
      carInUsePatent: 'ZZ999ZZ',
      message:
        'El vehículo en uso del chofer es la patente ZZ999ZZ y la hoja es de la AB123CD: el chofer tiene que tomar el vehículo de la hoja para iniciar el viaje',
    });
    expect(
      await codigo(
        armar({ enUso: null }).svc.iniciar(DIST, 'hoja-1', COMO_CHOFER, false),
      ),
    ).toBe('ROUTE_SHEET_CAR_NOT_IN_USE');
  });

  it('409 DRIVER_UNAVAILABLE por vencimientos o chofer deshabilitado', async () => {
    expect(
      await codigo(
        armar({ motivos: ['licencia vencida'] }).svc.iniciar(
          DIST,
          'hoja-1',
          COMO_CHOFER,
          false,
        ),
      ),
    ).toBe('ROUTE_SHEET_DRIVER_UNAVAILABLE');
    expect(
      await codigo(
        armar({ actor: chofer({ isEnabled: false }) }).svc.iniciar(
          DIST,
          'hoja-1',
          COMO_CHOFER,
          false,
        ),
      ),
    ).toBe('ROUTE_SHEET_DRIVER_UNAVAILABLE');
  });

  it('carga obligatoria: sin carga, en otro vehículo, sin salir o ya vuelta → 409, sin asignar nada', async () => {
    const casos: Array<[ReturnType<typeof carga> | null, string]> = [
      [null, 'ROUTE_SHEET_TRUCK_LOAD_REQUIRED'],
      [carga({ carId: 'auto-9' }), 'ROUTE_SHEET_TRUCK_LOAD_OTHER_CAR'],
      [
        carga({ status: TruckLoadStatus.LOADING }),
        'ROUTE_SHEET_TRUCK_LOAD_NOT_READY',
      ],
      [
        carga({ status: TruckLoadStatus.RETURNED }),
        'ROUTE_SHEET_TRUCK_LOAD_NOT_READY',
      ],
    ];
    for (const [c, esperado] of casos) {
      const t = armar({ carga: c });
      expect(
        await codigo(t.svc.iniciar(DIST, 'hoja-1', COMO_CHOFER, false)),
      ).toBe(esperado);
      expect(t.asignacion.asignarConCerrojoTomado).not.toHaveBeenCalled();
    }
  });

  it('carga incompleta (D-04): 409 SHORTAGES con el detalle; con acknowledgeShortages sale y los devuelve', async () => {
    const o = {
      carga: carga({ fullOnTruck: new Map([['g10', 1]]) }),
      pedido: [{ gasCylinderId: 'g10', type: '10 kg', units: 3 }],
    };
    let error: ConflictException | undefined;
    const corto = armar(o);
    await corto.svc
      .iniciar(DIST, 'hoja-1', COMO_CHOFER, false)
      .catch((e: ConflictException) => (error = e));
    expect(error?.getResponse()).toMatchObject({
      code: 'ROUTE_SHEET_SHORTAGES',
      shortages: [
        { gasCylinderId: 'g10', required: 3, onTruck: 1, missing: 2 },
      ],
    });
    expect(corto.save).not.toHaveBeenCalled();
    const r = await armar(o).svc.iniciar(DIST, 'hoja-1', COMO_CHOFER, true);
    expect(r.shortages).toEqual([
      {
        gasCylinderId: 'g10',
        type: '10 kg',
        required: 3,
        onTruck: 1,
        missing: 2,
      },
    ]);
  });

  it('ningún pedido asignable: 409 NOTHING_TO_START y la hoja sigue confirmada', async () => {
    const t = armar({ asignados: [], caidos: ['o1'] });
    expect(
      await codigo(t.svc.iniciar(DIST, 'hoja-1', COMO_CHOFER, false)),
    ).toBe('ROUTE_SHEET_NOTHING_TO_START');
    expect(t.sheet.status).toBe(RouteBatchStatus.CONFIRMED);
    expect(t.save).not.toHaveBeenCalled();
  });

  it('si al guardar la hoja ya no estaba confirmada, 409 NOT_STARTABLE', async () => {
    const t = armar();
    let lecturas = 0;
    (
      t.svc as unknown as {
        locks: { enTransaccion: jest.Mock };
      }
    ).locks.enTransaccion.mockImplementation(
      (
        _d: string,
        _p: unknown,
        fn: (m: EntityManager, h: RouteBatch[]) => unknown,
      ) => {
        lecturas += 1;
        const fila =
          lecturas === 1
            ? t.sheet
            : hoja({ status: RouteBatchStatus.DISSOLVED });
        return fn({ save: t.save } as unknown as EntityManager, [fila]);
      },
    );
    expect(
      await codigo(t.svc.iniciar(DIST, 'hoja-1', COMO_CHOFER, false)),
    ).toBe('ROUTE_SHEET_NOT_STARTABLE');
  });

  it('si los avisos a los clientes fallan, el viaje queda iniciado', async () => {
    const t = armar();
    t.eta.avisarSalida.mockRejectedValue(new Error('fcm'));
    await expect(
      t.svc.iniciar(DIST, 'hoja-1', COMO_CHOFER, false),
    ).resolves.toMatchObject({ alreadyStarted: false, notifiedCustomers: 0 });
  });
});
