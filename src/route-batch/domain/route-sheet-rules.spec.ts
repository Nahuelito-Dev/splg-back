import { RouteBatchStatus } from './route-batch.enums';
import {
  ConfirmacionInput,
  cierreDeLaPlanificacion,
  diaSiguiente,
  esCancelable,
  esEditable,
  esFechaDelCalendario,
  esPermutacionDe,
  instanteDelDia,
  motivoNoPlanificable,
  PedidoParaPlanificar,
  paradasNoPlanificables,
  salidaPorOmision,
  versionVigente,
  violacionesParaConfirmar,
} from './route-sheet-rules';

describe('route-sheet-rules', () => {
  describe('fechas (hora argentina, UTC−3)', () => {
    it('el cierre de D es D−1 a la hora del parámetro', () => {
      expect(cierreDeLaPlanificacion('2026-11-14', 18, 0).toISOString()).toBe(
        '2026-11-13T21:00:00.000Z',
      );
      expect(cierreDeLaPlanificacion('2026-12-01', 9, 30).toISOString()).toBe(
        '2026-11-30T12:30:00.000Z',
      );
    });

    it('un horario del día es instante argentino', () => {
      expect(
        new Date(instanteDelDia('2026-11-14', '09:00:00')).toISOString(),
      ).toBe('2026-11-14T12:00:00.000Z');
    });

    it('día siguiente cruza mes y año', () => {
      expect(diaSiguiente('2026-11-30')).toBe('2026-12-01');
      expect(diaSiguiente('2026-12-31')).toBe('2027-01-01');
    });

    it('fecha del calendario rechaza días que no existen', () => {
      expect(esFechaDelCalendario('2026-02-28')).toBe(true);
      expect(esFechaDelCalendario('2026-02-30')).toBe(false);
      expect(esFechaDelCalendario('14/11/2026')).toBe(false);
    });

    it('salida por omisión: media hora antes de la primera franja, nunca después de las 8', () => {
      const nueve = instanteDelDia('2026-11-14', '09:00');
      const siete = instanteDelDia('2026-11-14', '07:00');
      expect(salidaPorOmision('2026-11-14', [nueve])).toBe(
        instanteDelDia('2026-11-14', '08:00'),
      );
      expect(salidaPorOmision('2026-11-14', [nueve, siete])).toBe(
        instanteDelDia('2026-11-14', '06:30'),
      );
      expect(salidaPorOmision('2026-11-14', [])).toBe(
        instanteDelDia('2026-11-14', '08:00'),
      );
    });
  });

  describe('edición', () => {
    it('sólo el borrador es editable', () => {
      expect(esEditable(RouteBatchStatus.DRAFT)).toBe(true);
      for (const s of [
        RouteBatchStatus.CONFIRMED,
        RouteBatchStatus.ASSIGNED,
        RouteBatchStatus.COMPLETED,
        RouteBatchStatus.DISSOLVED,
      ]) {
        expect(esEditable(s)).toBe(false);
      }
    });

    it('se cancela borrador o confirmada, no la iniciada ni la cerrada', () => {
      expect(esCancelable(RouteBatchStatus.DRAFT)).toBe(true);
      expect(esCancelable(RouteBatchStatus.CONFIRMED)).toBe(true);
      expect(esCancelable(RouteBatchStatus.ASSIGNED)).toBe(false);
      expect(esCancelable(RouteBatchStatus.COMPLETED)).toBe(false);
      expect(esCancelable(RouteBatchStatus.DISSOLVED)).toBe(false);
    });

    it('versión optimista: sólo la misma versión es vigente', () => {
      expect(versionVigente(3, 3)).toBe(true);
      expect(versionVigente(3, 2)).toBe(false);
      expect(versionVigente(3, 4)).toBe(false);
    });

    it('el orden manual tiene que ser exactamente las paradas activas', () => {
      expect(esPermutacionDe(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true);
      expect(esPermutacionDe(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
      expect(esPermutacionDe(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
      expect(esPermutacionDe(['a', 'b'], ['a', 'a'])).toBe(false);
      expect(esPermutacionDe(['a', 'b', 'c'], ['a', 'a', 'b'])).toBe(false);
      expect(esPermutacionDe(['a', 'b'], ['a', 'x'])).toBe(false);
    });
  });

  describe('confirmar', () => {
    const ok: ConfirmacionInput = {
      deliveryId: 'd',
      carId: 'c',
      stopCount: 2,
      driverUnavailable: false,
      carUnavailable: false,
      driverTaken: false,
      carTaken: false,
      peakKg: 100,
      peakUnits: 10,
      capacityKg: 100,
      capacityUnits: 10,
      lateOrderIds: [],
      acceptLateStops: false,
    };
    const codigos = (i: Partial<ConfirmacionInput>) =>
      violacionesParaConfirmar({ ...ok, ...i }).map((v) => v.code);

    it('una hoja completa en el límite exacto de la capacidad se confirma', () => {
      expect(codigos({})).toEqual([]);
    });

    it('sin capacidad cargada no hay tope', () => {
      expect(
        codigos({
          capacityKg: null,
          capacityUnits: null,
          peakKg: 9999,
          peakUnits: 999,
        }),
      ).toEqual([]);
    });

    it.each([
      [{ deliveryId: null }, 'driver_missing'],
      [{ carId: null }, 'car_missing'],
      [{ stopCount: 0 }, 'no_stops'],
      [{ driverUnavailable: true }, 'driver_unavailable'],
      [{ carUnavailable: true }, 'car_unavailable'],
      [{ driverTaken: true }, 'driver_taken'],
      [{ carTaken: true }, 'car_taken'],
      [{ peakKg: 100.01 }, 'capacity_kg'],
      [{ peakUnits: 11 }, 'capacity_units'],
      [{ lateOrderIds: ['o1'] }, 'late_stops'],
    ] as Array<[Partial<ConfirmacionInput>, string]>)(
      '%j → %s',
      (cambio, codigo) => {
        expect(codigos(cambio)).toEqual([codigo]);
      },
    );

    it('las paradas fuera de franja se aceptan con acceptLateStops y vienen con sus pedidos si no', () => {
      expect(
        codigos({ lateOrderIds: ['o1', 'o2'], acceptLateStops: true }),
      ).toEqual([]);
      const [v] = violacionesParaConfirmar({
        ...ok,
        lateOrderIds: ['o1', 'o2'],
      });
      expect(v.orderIds).toEqual(['o1', 'o2']);
      expect(v.message).toMatch(/2 paradas llegan fuera de su franja/);
    });

    it('las paradas con pedidos que ya no se pueden repartir no se aceptan nunca (ni con acceptLateStops)', () => {
      expect(
        codigos({ unplannableOrderIds: ['o1'], acceptLateStops: true }),
      ).toEqual(['stops_not_plannable']);
      const [uno] = violacionesParaConfirmar({
        ...ok,
        unplannableOrderIds: ['o1'],
      });
      expect(uno).toMatchObject({
        orderIds: ['o1'],
        message: expect.stringMatching(/^Una parada tiene un pedido/) as string,
      });
      const [dos] = violacionesParaConfirmar({
        ...ok,
        unplannableOrderIds: ['o1', 'o2'],
      });
      expect(dos.message).toMatch(/^2 paradas tienen pedidos/);
      expect(codigos({ unplannableOrderIds: [] })).toEqual([]);
    });

    it('sin chofer no se reporta además que no está disponible', () => {
      expect(
        codigos({
          deliveryId: null,
          driverUnavailable: true,
          driverTaken: true,
        }),
      ).toEqual(['driver_missing']);
      expect(
        codigos({ carId: null, carUnavailable: true, carTaken: true }),
      ).toEqual(['car_missing']);
    });

    it('junta todas las violaciones', () => {
      expect(codigos({ deliveryId: null, carId: null, stopCount: 0 })).toEqual([
        'driver_missing',
        'car_missing',
        'no_stops',
      ]);
    });
  });

  describe('pedido planificable para el día', () => {
    const base: PedidoParaPlanificar = {
      status: 'pending',
      deliveryId: null,
      scheduledDate: '2026-11-14',
      hasSlot: true,
      deliveryMode: 'standard',
      depositPaid: false,
      fraudHold: false,
      hasPoint: true,
    };
    const motivo = (c: Partial<PedidoParaPlanificar>) =>
      motivoNoPlanificable({ ...base, ...c }, '2026-11-14');

    it('pendiente, de ese día, con franja y punto: entra', () => {
      expect(motivo({})).toBeNull();
    });

    it('reservado con la seña paga entra; sin pagar no', () => {
      expect(motivo({ status: 'reserved', depositPaid: true })).toBeNull();
      expect(motivo({ status: 'reserved' })).toBe(
        'no está pendiente de entrega',
      );
    });

    it.each([
      [{ scheduledDate: '2026-11-15' }, 'está programado para otro día'],
      [{ scheduledDate: null }, 'está programado para otro día'],
      [{ hasSlot: false }, 'no tiene franja horaria'],
      [{ deliveryMode: 'express' }, 'es un pedido express'],
      [{ deliveryId: 'x' }, 'ya tiene chofer'],
      [{ status: 'accepted' }, 'no está pendiente de entrega'],
      [{ fraudHold: true }, 'está retenido por la revisión del pago'],
      [{ hasPoint: false }, 'no tiene punto de entrega'],
    ] as Array<[Partial<PedidoParaPlanificar>, string]>)('%j → %s', (c, m) => {
      expect(motivo(c)).toBe(m);
    });
  });

  describe('paradasNoPlanificables', () => {
    const p = (orderId: string, c: Partial<PedidoParaPlanificar> = {}) => ({
      orderId,
      status: 'pending',
      deliveryId: null,
      scheduledDate: '2026-11-14',
      hasSlot: true,
      deliveryMode: 'standard',
      depositPaid: false,
      fraudHold: false,
      hasPoint: true,
      ...c,
    });

    it('las cancelados, con chofer, de otro día o que ya no se ven; las vigentes no', () => {
      expect(
        paradasNoPlanificables(
          ['o1', 'o2', 'o3', 'o4', 'o5'],
          [
            p('o1'),
            p('o2', { status: 'cancelled' }),
            p('o3', { deliveryId: 'd' }),
            p('o4', { scheduledDate: '2026-11-15' }),
          ],
          '2026-11-14',
        ),
      ).toEqual(['o2', 'o3', 'o4', 'o5']);
    });
  });
});
