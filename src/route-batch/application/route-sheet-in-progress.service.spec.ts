import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { RoleType } from '../../common/constants/role-type.enum';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { DeliveryService } from '../../delivery/delivery.service';
import { OrderStatus } from '../../order/entities/order.entity';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import {
  RouteBatchStop,
  RouteStopRemovedReason,
} from '../../order/entities/route-batch-stop.entity';
import { OrderService } from '../../order/order.service';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import {
  CALENDARIO_POR_OMISION,
  diasDeLaMascara,
} from '../domain/calendario-laboral';
import { RoutePlanningCalendarService } from './route-planning-calendar.service';
import { RouteSheetEtaService } from './route-sheet-eta.service';
import { RouteSheetInProgress } from './route-sheet-in-progress.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { RouteSheetNotifier } from './route-sheet-notifier.service';
import {
  CalculoEnCurso,
  RouteSheetProgress,
} from './route-sheet-progress.service';
import { DIST, hoja, parada } from './route-sheet.fixtures';

const CALCULO: CalculoEnCurso = {
  recorrido: { hechas: [], enCamino: null, pendientes: ['o1'] },
  cola: ['o1'],
  etas: [],
  origen: 'warehouse',
};

const chofer = (over: Partial<Delivery> = {}) =>
  ({
    deliveryId: 'chofer-1',
    userId: 'u-chofer',
    distributorId: DIST,
    notificationToken: 'tok',
    ...over,
  }) as Delivery;

const codigo = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'sin error';
  } catch (e) {
    return (e as { getResponse: () => { code?: string } }).getResponse().code;
  }
};

function armar(o: { sheet?: RouteBatch | null; release?: Error } = {}) {
  const sheet =
    o.sheet === undefined
      ? hoja({ status: RouteBatchStatus.ASSIGNED })
      : o.sheet;
  const update = jest.fn().mockResolvedValue(undefined);
  const save = jest.fn().mockResolvedValue(undefined);
  const ds = {
    manager: { update: jest.fn().mockResolvedValue(undefined) },
    query: jest.fn().mockResolvedValue([]),
  };
  const sheets = { findOne: jest.fn().mockResolvedValue(sheet) };
  const locks = {
    enTransaccion: jest.fn(
      (
        _d: string,
        _p: unknown,
        fn: (m: EntityManager, h: RouteBatch[]) => unknown,
      ) =>
        fn({ update, save } as unknown as EntityManager, [sheet as RouteBatch]),
    ),
  };
  const progress = {
    posicionDelChofer: jest.fn().mockResolvedValue({ lat: 1, lng: 2 }),
    rehacer: jest.fn().mockResolvedValue(CALCULO),
  };
  const orders = {
    reprogramarEntrega: jest
      .fn()
      .mockResolvedValue({ customerId: 'c1', scheduledDate: '2026-11-16' }),
    updateStatus: o.release
      ? jest.fn().mockRejectedValue(o.release)
      : jest.fn().mockResolvedValue({}),
  };
  const deliveries = {
    findOneByUserId: jest.fn().mockResolvedValue(chofer()),
    findById: jest.fn().mockResolvedValue(chofer()),
  };
  const eta = { avisar: jest.fn().mockResolvedValue(null) };
  const notifier = {
    alChofer: jest.fn(),
    alPanel: jest.fn(),
    aLaBandeja: jest.fn(),
    reprogramadoAlCliente: jest.fn().mockResolvedValue(undefined),
    pushAlChofer: jest.fn().mockResolvedValue(undefined),
  };
  const calendario = {
    calendario: jest.fn().mockResolvedValue(CALENDARIO_POR_OMISION),
  };
  const svc = new RouteSheetInProgress(
    ds as unknown as DataSource,
    sheets as unknown as Repository<RouteBatch>,
    locks as unknown as RouteSheetLocks,
    progress as unknown as RouteSheetProgress,
    orders as unknown as OrderService,
    deliveries as unknown as DeliveryService,
    eta as unknown as RouteSheetEtaService,
    notifier as unknown as RouteSheetNotifier,
    calendario as unknown as RoutePlanningCalendarService,
  );
  return {
    calendario,
    svc,
    sheet,
    update,
    save,
    ds,
    sheets,
    progress,
    orders,
    deliveries,
    eta,
    notifier,
  };
}

describe('RouteSheetInProgress', () => {
  describe('sacarYLiberar', () => {
    it('saca la parada con motivo y nota y libera el pedido como el chofer', async () => {
      const t = armar();
      await t.svc.sacarYLiberar(
        t.sheet as RouteBatch,
        'o1',
        { userId: 'u-chofer', esChofer: true },
        { motivo: RouteStopRemovedReason.FAILED_DELIVERY, nota: 'No estaba' },
      );
      expect(t.update).toHaveBeenCalledWith(
        RouteBatchStop,
        { batchId: 'hoja-1', orderId: 'o1', active: true },
        expect.objectContaining({
          active: false,
          removedReason: RouteStopRemovedReason.FAILED_DELIVERY,
          removedNote: 'No estaba',
        }),
      );
      expect(t.save).not.toHaveBeenCalled();
      expect(t.orders.updateStatus).toHaveBeenCalledWith(
        'o1',
        OrderStatus.PENDING,
        'u-chofer',
        RoleType.DELIVERY,
        'u-chofer',
      );
    });

    it('como admin libera con rol de admin y sube la versión si se pide', async () => {
      const t = armar();
      await t.svc.sacarYLiberar(
        t.sheet as RouteBatch,
        'o1',
        { userId: 'u-admin', esChofer: false },
        { motivo: RouteStopRemovedReason.ADMIN, nota: null },
        true,
      );
      expect(t.save).toHaveBeenCalled();
      expect(t.orders.updateStatus).toHaveBeenCalledWith(
        'o1',
        OrderStatus.PENDING,
        undefined,
        RoleType.ADMIN,
        'u-admin',
      );
    });

    it('si la liberación falla, la parada vuelve a la hoja y el error sube', async () => {
      const t = armar({ release: new BadRequestException('ya entregado') });
      await expect(
        t.svc.sacarYLiberar(
          t.sheet as RouteBatch,
          'o1',
          { userId: 'u', esChofer: true },
          { motivo: RouteStopRemovedReason.FAILED_DELIVERY, nota: null },
        ),
      ).rejects.toThrow('ya entregado');
      expect(t.ds.manager.update).toHaveBeenCalledWith(
        RouteBatchStop,
        { batchId: 'hoja-1', orderId: 'o1' },
        {
          active: true,
          removedReason: null,
          removedAt: null,
          removedNote: null,
        },
      );
    });
  });

  describe('rehacer', () => {
    it('recalcula en curso con la posición del chofer y avisa', async () => {
      const t = armar();
      const r = await t.svc.rehacer(DIST, 'hoja-1', 'u-chofer', {
        reordenar: true,
      });
      expect(r).toEqual({ ...CALCULO, postergado: null });
      expect(t.progress.rehacer).toHaveBeenCalledWith(
        expect.anything(),
        t.sheet,
        expect.objectContaining({
          reordenar: true,
          posicion: { lat: 1, lng: 2 },
        }),
      );
      expect(t.eta.avisar).toHaveBeenCalledWith(
        DIST,
        'hoja-1',
        CALCULO,
        expect.any(Number),
        'u-chofer',
        { postergado: undefined },
      );
    });

    it('con un postergado: se lo pasa a los avisos y devuelve su franja nueva', async () => {
      const t = armar();
      const franja = { windowStartMs: 1, windowEndMs: 2, etaMs: 1 };
      t.eta.avisar.mockResolvedValue(franja);
      const r = await t.svc.rehacer(DIST, 'hoja-1', 'u-chofer', {
        reordenar: true,
        postergado: 'o1',
      });
      expect(r?.postergado).toBe(franja);
      expect((t.eta.avisar.mock.calls as unknown[][])[0][5]).toEqual({
        postergado: 'o1',
      });
    });

    it('si la hoja ya no está en curso no recalcula; sin chofer, sin posición; un aviso que falla no rompe', async () => {
      const cerrada = armar({
        sheet: hoja({ status: RouteBatchStatus.COMPLETED }),
      });
      expect(
        await cerrada.svc.rehacer(DIST, 'hoja-1', null, { reordenar: false }),
      ).toBeNull();
      expect(cerrada.eta.avisar).not.toHaveBeenCalled();
      expect(cerrada.progress.posicionDelChofer).not.toHaveBeenCalled();
      const falla = armar();
      falla.eta.avisar.mockRejectedValue(new Error('x'));
      await expect(
        falla.svc.rehacer(DIST, 'hoja-1', null, { reordenar: false }),
      ).resolves.toEqual({ ...CALCULO, postergado: null });
    });
  });

  it('trasCambio avisa al cliente y al panel aunque los avisos fallen', async () => {
    const t = armar();
    t.eta.avisar.mockRejectedValue(new Error('x'));
    await t.svc.trasCambio(DIST, 'hoja-1', CALCULO, null);
    expect(t.notifier.alPanel).toHaveBeenCalledWith(
      DIST,
      'route-sheet:updated',
      {
        sheetId: 'hoja-1',
        status: RouteBatchStatus.ASSIGNED,
      },
    );
    await t.svc.trasCambio(DIST, 'hoja-1', CALCULO, chofer());
    expect(t.eta.avisar).toHaveBeenLastCalledWith(
      DIST,
      'hoja-1',
      CALCULO,
      expect.any(Number),
      'u-chofer',
    );
  });

  it.each([
    ['stop_added', 'Se agregó una parada a tu hoja.'],
    ['stop_removed', 'Una parada salió de tu hoja.'],
    ['stop_failed', 'Una parada se marcó como no entregada.'],
    ['reordered', 'Se reordenaron las paradas que te faltan.'],
  ] as const)(
    'avisarCambio %s: socket y push en castellano',
    (motivo, texto) => {
      const t = armar();
      t.svc.avisarCambio(chofer(), 'hoja-1', motivo, { orderId: 'o1' });
      expect(t.notifier.alChofer).toHaveBeenCalledWith(
        'u-chofer',
        'route-sheet:changed',
        { sheetId: 'hoja-1', reason: motivo, orderId: 'o1' },
      );
      expect(t.notifier.pushAlChofer).toHaveBeenCalledWith(
        'tok',
        'hoja-1',
        texto,
      );
    },
  );

  describe('enCurso', () => {
    it('devuelve la hoja en curso', async () => {
      const t = armar();
      await expect(t.svc.enCurso(DIST, 'hoja-1', 3)).resolves.toBe(t.sheet);
      await expect(t.svc.enCurso(DIST, 'hoja-1')).resolves.toBe(t.sheet);
    });

    it('404 si no existe; 409 si no está en curso o la versión quedó vieja', async () => {
      expect(await codigo(armar({ sheet: null }).svc.enCurso(DIST, 'x'))).toBe(
        'ROUTE_SHEET_NOT_FOUND',
      );
      expect(
        await codigo(
          armar({
            sheet: hoja({ status: RouteBatchStatus.CONFIRMED }),
          }).svc.enCurso(DIST, 'hoja-1'),
        ),
      ).toBe('ROUTE_SHEET_NOT_IN_PROGRESS');
      expect(await codigo(armar().svc.enCurso(DIST, 'hoja-1', 2))).toBe(
        'ROUTE_SHEET_VERSION_CONFLICT',
      );
    });
  });

  it('parada: la activa de la hoja, o 404', () => {
    const t = armar();
    const p = {
      stop: parada('o1', 1),
      pedido: null,
      progress: 'pending' as const,
    };
    expect(t.svc.parada([p], 'o1')).toBe(p);
    expect(() => t.svc.parada([p], 'o9')).toThrow(
      'El pedido no es una parada de esta hoja',
    );
  });

  describe('choferDeLaHoja', () => {
    it('el chofer de la hoja', async () => {
      await expect(
        armar().svc.choferDeLaHoja(DIST, 'hoja-1', 'u-chofer'),
      ).resolves.toMatchObject({
        deliveryId: 'chofer-1',
      });
    });

    it('404 si no es chofer, es de otra distribuidora, la hoja no existe o es de otro', async () => {
      const sinPerfil = armar();
      sinPerfil.deliveries.findOneByUserId.mockRejectedValue(new Error('no'));
      expect(
        await codigo(sinPerfil.svc.choferDeLaHoja(DIST, 'hoja-1', 'u')),
      ).toBe('ROUTE_SHEET_NOT_FOUND');
      const ajeno = armar();
      ajeno.deliveries.findOneByUserId.mockResolvedValue(
        chofer({ distributorId: 'otra' }),
      );
      expect(await codigo(ajeno.svc.choferDeLaHoja(DIST, 'hoja-1', 'u'))).toBe(
        'ROUTE_SHEET_NOT_FOUND',
      );
      expect(
        await codigo(
          armar({ sheet: null }).svc.choferDeLaHoja(DIST, 'hoja-1', 'u'),
        ),
      ).toBe('ROUTE_SHEET_NOT_FOUND');
      const otro = armar();
      otro.deliveries.findOneByUserId.mockResolvedValue(
        chofer({ deliveryId: 'chofer-2' }),
      );
      expect(await codigo(otro.svc.choferDeLaHoja(DIST, 'hoja-1', 'u'))).toBe(
        'ROUTE_SHEET_NOT_FOUND',
      );
    });
  });

  it('choferDe: el de la hoja o null', async () => {
    const t = armar();
    await expect(t.svc.choferDe({ deliveryId: null })).resolves.toBeNull();
    await expect(
      t.svc.choferDe({ deliveryId: 'chofer-1' }),
    ).resolves.toMatchObject({
      userId: 'u-chofer',
    });
  });

  it('otroEnCaminoDelChofer mira los pedidos en camino del chofer salvo éste', async () => {
    const t = armar();
    expect(await t.svc.otroEnCaminoDelChofer('chofer-1', 'o1')).toBe(false);
    t.ds.query.mockResolvedValue([{ '?column?': 1 }]);
    expect(await t.svc.otroEnCaminoDelChofer('chofer-1', 'o1')).toBe(true);
    expect((t.ds.query.mock.calls as unknown[][])[0][1]).toEqual([
      'chofer-1',
      'o1',
    ]);
  });

  describe('reprogramar', () => {
    const AHORA = Date.now();
    const encendida = (
      t: ReturnType<typeof armar>,
      planes: Array<{ fecha: string; status: string; cutoffAt: Date }>,
      enabled = 1,
      jornada = true,
    ) =>
      t.ds.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('"module_config"')
            ? [{ enabled }]
            : sql.includes('"route_plan"')
              ? planes
              : sql.includes('"time_slot"')
                ? [{ hay: jornada }]
                : [],
        ),
      );

    it('sin plan todavía para el día hábil siguiente: ese día (sábado → lunes), y avisa al cliente y al admin', async () => {
      const t = armar();
      encendida(t, []);
      const fecha = await t.svc.reprogramar(
        hoja({ planDate: '2026-11-14', distributorId: DIST }),
        'o1',
      );
      expect(fecha).toBe('2026-11-16');
      expect(t.orders.reprogramarEntrega).toHaveBeenCalledWith(
        'o1',
        '2026-11-16',
      );
      expect(t.notifier.reprogramadoAlCliente).toHaveBeenCalledWith(
        'c1',
        'o1',
        '2026-11-16',
      );
      expect(t.notifier.aLaBandeja).toHaveBeenCalledWith(
        DIST,
        expect.objectContaining({
          kind: 'route_sheet_order_rescheduled',
          body: expect.stringContaining('lunes 16/11') as string,
        }),
      );
      // Con la hoja de ruta encendida, no queda esperando al admin.
      expect(t.ds.manager.update).not.toHaveBeenCalled();
    });

    it('si el plan de mañana ya se propuso (o se cerró, o pasó su cierre), pasado mañana', async () => {
      const t = armar();
      encendida(t, [
        {
          fecha: '2026-11-17',
          status: 'proposed',
          cutoffAt: new Date(AHORA - 1000),
        },
      ]);
      expect(
        await t.svc.reprogramar(hoja({ planDate: '2026-11-16' }), 'o1'),
      ).toBe('2026-11-18');
      const t2 = armar();
      encendida(t2, [
        {
          fecha: '2026-11-17',
          status: 'open',
          cutoffAt: new Date(AHORA - 1000),
        },
        {
          fecha: '2026-11-18',
          status: 'closed',
          cutoffAt: new Date(AHORA - 1000),
        },
      ]);
      expect(
        await t2.svc.reprogramar(hoja({ planDate: '2026-11-16' }), 'o1'),
      ).toBe('2026-11-19');
    });

    it('un plan abierto con el cierre por delante sirve', async () => {
      const t = armar();
      encendida(t, [
        {
          fecha: '2026-11-17',
          status: 'open',
          cutoffAt: new Date(AHORA + 3600_000),
        },
      ]);
      expect(
        await t.svc.reprogramar(hoja({ planDate: '2026-11-16' }), 'o1'),
      ).toBe('2026-11-17');
    });

    it('sin franjas activas (sin jornada): no queda suelto; día hábil siguiente y esperando al admin, con aviso', async () => {
      const t = armar();
      encendida(t, [], 1, false);
      const fecha = await t.svc.reprogramar(
        hoja({ planDate: '2026-11-14' }),
        'o1',
      );
      expect(fecha).toBe('2026-11-16');
      expect(t.ds.manager.update).toHaveBeenCalledWith(
        RouteBatchStop,
        { batchId: 'hoja-1', orderId: 'o1', active: false },
        { removedReason: RouteStopRemovedReason.NEEDS_RESCHEDULE },
      );
      expect(t.notifier.aLaBandeja).toHaveBeenCalledWith(
        DIST,
        expect.objectContaining({
          kind: 'route_sheet_reschedule_needs_admin',
          body: expect.stringContaining('franjas horarias activas') as string,
        }),
      );
    });

    it('sólo lunes y todos los lunes del horizonte ocupados: no inventa fecha, queda esperando al admin', async () => {
      const t = armar();
      const lunes = Array.from({ length: 9 }, (_, i) => {
        const d = new Date('2026-11-23T12:00:00Z');
        d.setUTCDate(d.getUTCDate() + 7 * i);
        return {
          fecha: d.toISOString().slice(0, 10),
          status: 'closed',
          cutoffAt: new Date(AHORA - 1000),
        };
      });
      encendida(t, lunes);
      t.calendario.calendario.mockResolvedValue({
        diasHabiles: diasDeLaMascara(1),
        feriados: new Set(),
      });
      expect(
        await t.svc.reprogramar(hoja({ planDate: '2026-11-16' }), 'o1'),
      ).toBeNull();
      expect(t.orders.reprogramarEntrega).not.toHaveBeenCalled();
      expect(t.ds.manager.update).toHaveBeenCalledWith(
        RouteBatchStop,
        { batchId: 'hoja-1', orderId: 'o1', active: false },
        { removedReason: RouteStopRemovedReason.NEEDS_RESCHEDULE },
      );
      expect(t.notifier.aLaBandeja).toHaveBeenCalledWith(
        DIST,
        expect.objectContaining({
          kind: 'route_sheet_reschedule_needs_admin',
          body: expect.stringContaining('próximos 60 días') as string,
        }),
      );
      // Los planes se leen en todo el rango que se recorre.
      const consulta = (t.ds.query.mock.calls as unknown[][]).find((c) =>
        String(c[0]).includes('"route_plan"'),
      );
      expect(consulta?.[1]).toEqual([DIST, '2026-11-16', 60]);
      // Con un lunes libre (el 7/12), ese.
      const t2 = armar();
      encendida(t2, lunes.slice(0, 2));
      t2.calendario.calendario.mockResolvedValue({
        diasHabiles: diasDeLaMascara(1),
        feriados: new Set(),
      });
      expect(
        await t2.svc.reprogramar(hoja({ planDate: '2026-11-16' }), 'o1'),
      ).toBe('2026-12-07');
    });

    it('saltea los feriados y los días que la distribuidora no reparte (workingDays)', async () => {
      const t = armar();
      encendida(t, []);
      // Lunes a viernes (31) y el lunes 16/11 feriado: del viernes 13 al martes 17.
      t.calendario.calendario.mockResolvedValue({
        diasHabiles: diasDeLaMascara(31),
        feriados: new Set(['2026-11-16']),
      });
      expect(
        await t.svc.reprogramar(hoja({ planDate: '2026-11-13' }), 'o1'),
      ).toBe('2026-11-17');
      expect(t.calendario.calendario).toHaveBeenCalledWith(DIST, '2026-11-13');
      // Apagada, igual: el día hábil siguiente de la distribuidora.
      const t2 = armar();
      encendida(t2, [], 0);
      t2.calendario.calendario.mockResolvedValue({
        diasHabiles: diasDeLaMascara(31),
        feriados: new Set(['2026-11-16']),
      });
      expect(
        await t2.svc.reprogramar(hoja({ planDate: '2026-11-13' }), 'o1'),
      ).toBe('2026-11-17');
    });

    it('con la hoja de ruta apagada: el día hábil siguiente y queda esperando al admin (nadie lo despacha solo)', async () => {
      const t = armar();
      encendida(t, [], 0);
      const fecha = await t.svc.reprogramar(
        hoja({ planDate: '2026-11-14' }),
        'o1',
      );
      expect(fecha).toBe('2026-11-16');
      expect(t.ds.manager.update).toHaveBeenCalledWith(
        RouteBatchStop,
        { batchId: 'hoja-1', orderId: 'o1', active: false },
        { removedReason: RouteStopRemovedReason.NEEDS_RESCHEDULE },
      );
      expect(t.notifier.aLaBandeja).toHaveBeenCalledWith(
        DIST,
        expect.objectContaining({ kind: 'route_sheet_reschedule_needs_admin' }),
      );
    });

    it('si no se puede (se canceló o se asignó en el medio), la parada queda esperando al admin y se avisa', async () => {
      const t = armar();
      encendida(t, []);
      t.orders.reprogramarEntrega.mockRejectedValue(
        new ConflictException('no'),
      );
      const fecha = await t.svc.reprogramar(
        hoja({ planDate: '2026-11-16' }),
        'o1',
      );
      expect(fecha).toBeNull();
      expect(t.ds.manager.update).toHaveBeenCalledWith(
        RouteBatchStop,
        { batchId: 'hoja-1', orderId: 'o1', active: false },
        { removedReason: RouteStopRemovedReason.NEEDS_RESCHEDULE },
      );
      expect(t.notifier.aLaBandeja).toHaveBeenCalledWith(
        DIST,
        expect.objectContaining({ kind: 'route_sheet_reschedule_failed' }),
      );
    });

    it('un push que falla no deshace la reprogramación', async () => {
      const t = armar();
      encendida(t, []);
      t.notifier.reprogramadoAlCliente.mockRejectedValue(new Error('fcm'));
      expect(
        await t.svc.reprogramar(hoja({ planDate: '2026-11-16' }), 'o1'),
      ).toBe('2026-11-17');
    });
  });
});
