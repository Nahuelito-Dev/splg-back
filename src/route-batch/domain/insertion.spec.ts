import { InvalidRouteInputError } from './errors/route-sheet.errors';
import { computeSchedule } from './eta';
import { bestInsertion, InsertionResult } from './insertion';
import { SIN_CARGA, StopLoad } from './load-profile';
import { MIN, scheduleParams, stopAt, T0, XY } from './route-fixtures';

/** Una recta: depósito en 0 y puntos a x km. A 30 km/h, 1 km son 2 minutos. */
const recta = (...xs: number[]): XY[] => [
  { x: 0, y: 0 },
  ...xs.map((x) => ({ x, y: 0 })),
];

const ok = (r: InsertionResult) => {
  if (!r.ok) throw new Error(`se esperaba una inserción y falló: ${r.reason}`);
  return r;
};

const carga = (kg: number, units = 1): StopLoad => ({
  ...SIN_CARGA,
  deliverKg: kg,
  deliverUnits: units,
});

describe('bestInsertion', () => {
  describe('posición más barata', () => {
    const puntos = recta(2, 6, 4, 20);
    const params = scheduleParams(puntos);
    const ruta = [stopAt('a', 1, 0, 1000), stopAt('b', 2, 0, 1000)];

    it('una parada que está de camino entra en medio y sólo cuesta el tiempo de servicio', () => {
      const r = ok(
        bestInsertion(ruta, stopAt('c', 3, 0, 1000), { schedule: params }),
      );
      expect(r.position).toBe(1);
      expect(r.addedMinutes).toBeCloseTo(10);
      expect(r.addedKm).toBeCloseTo(0);
      expect(r.order.map((s) => s.id)).toEqual(['a', 'c', 'b']);
      expect(r.late).toBe(false);
      expect(r.shiftedLocked).toEqual([]);
    });

    it('una parada más allá de la última va al final', () => {
      const r = ok(
        bestInsertion(ruta, stopAt('d', 4, 0, 1000), { schedule: params }),
      );
      expect(r.position).toBe(2);
      // 14 km más a 30 km/h son 28 min, más 10 de servicio.
      expect(r.addedMinutes).toBeCloseTo(38);
      expect(r.addedKm).toBeCloseTo(14);
    });

    it('en una hoja vacía entra en la posición 0', () => {
      const r = ok(
        bestInsertion([], stopAt('c', 3, 0, 1000), { schedule: params }),
      );
      expect(r.position).toBe(0);
      expect(r.order).toHaveLength(1);
    });

    it('el resultado trae la hoja ya calculada', () => {
      const r = ok(
        bestInsertion(ruta, stopAt('c', 3, 0, 1000), { schedule: params }),
      );
      expect(r.schedule).toEqual(computeSchedule(r.order, params));
    });
  });

  describe('franjas', () => {
    // a está a 2 km (4 min), nueva está a 10 km (20 min).
    const puntos = recta(2, 10);
    const params = scheduleParams(puntos);
    const ruta = [stopAt('a', 1, 0, 1000)];

    it('una franja que cierra pronto fuerza ir primero aunque cueste más', () => {
      const r = ok(
        bestInsertion(ruta, stopAt('apurada', 2, 0, 25), { schedule: params }),
      );
      expect(r.position).toBe(0);
    });

    it('no inserta donde rompería la franja de una parada que ya estaba', () => {
      // a tiene que ser atendida antes de los 10 min: la nueva (a 20 min) no puede ir antes.
      const estricta = [stopAt('a', 1, 0, 6)];
      const r = ok(
        bestInsertion(estricta, stopAt('n', 2, 0, 1000), { schedule: params }),
      );
      expect(r.position).toBe(1);
    });

    it('si no hay posición factible se rechaza por franja', () => {
      const r = bestInsertion(ruta, stopAt('imposible', 2, 0, 5), {
        schedule: params,
      });
      expect(r).toEqual({ ok: false, reason: 'window' });
    });

    it('con allowLate elige la posición que deja menos paradas tarde y lo marca', () => {
      const r = ok(
        bestInsertion(
          ruta,
          stopAt('imposible', 2, 0, 5),
          { schedule: params },
          { allowLate: true },
        ),
      );
      expect(r.late).toBe(true);
      expect(r.schedule.lateCount).toBe(1);
    });

    it('allowLate no hace entrar lo que ya no cabe por capacidad', () => {
      const r = bestInsertion(
        ruta,
        stopAt('imposible', 2, 0, 5),
        {
          schedule: params,
          capacity: {
            capacityKg: 10,
            capacityUnits: null,
            loads: new Map([
              ['a', carga(10)],
              ['imposible', carga(10)],
            ]),
          },
        },
        { allowLate: true },
      );
      expect(r).toEqual({ ok: false, reason: 'capacity' });
    });

    it('una hoja que ya tenía una parada tarde no impide insertar otra que no empeora nada', () => {
      const conTarde = [stopAt('tarde', 1, 0, 1)]; // a 4 min con franja de 1: ya está tarde
      const r = ok(
        bestInsertion(
          conTarde,
          stopAt('n', 2, 0, 1000),
          { schedule: params },
          { minPosition: 1 },
        ),
      );
      expect(r.position).toBe(1);
      expect(r.schedule.lateCount).toBe(1);
    });
  });

  describe('capacidad y tope de paradas', () => {
    const puntos = recta(2, 4, 6);
    const params = scheduleParams(puntos);
    const ruta = [stopAt('a', 1, 0, 1000), stopAt('b', 2, 0, 1000)];
    const cargas = new Map<string, StopLoad>([
      ['a', carga(90, 4)],
      ['b', carga(10, 1)],
      ['c', carga(20, 1)],
    ]);

    it('rechaza por capacidad de kilos', () => {
      const r = bestInsertion(ruta, stopAt('c', 3, 0, 1000), {
        schedule: params,
        capacity: { capacityKg: 110, capacityUnits: null, loads: cargas },
      });
      expect(r).toEqual({ ok: false, reason: 'capacity' });
    });

    it('rechaza por capacidad de garrafas aunque los kilos alcancen', () => {
      const r = bestInsertion(ruta, stopAt('c', 3, 0, 1000), {
        schedule: params,
        capacity: { capacityKg: 1000, capacityUnits: 5, loads: cargas },
      });
      expect(r).toEqual({ ok: false, reason: 'capacity' });
    });

    it('entra justo en la capacidad', () => {
      const r = bestInsertion(ruta, stopAt('c', 3, 0, 1000), {
        schedule: params,
        capacity: { capacityKg: 120, capacityUnits: 6, loads: cargas },
      });
      expect(r.ok).toBe(true);
    });

    it('sin capacidad cargada no hay tope', () => {
      const r = bestInsertion(ruta, stopAt('c', 3, 0, 1000), {
        schedule: params,
        capacity: { capacityKg: null, capacityUnits: null, loads: cargas },
      });
      expect(r.ok).toBe(true);
    });

    it('la capacidad se mide en el orden resultante: un retiro antes de entregar sube el pico', () => {
      const retira: StopLoad = { ...SIN_CARGA, pickupUnits: 3, pickupKg: 36 };
      const mapa = new Map<string, StopLoad>([
        ['a', carga(44, 2)],
        ['retiro', retira],
      ]);
      const r = ok(
        bestInsertion([stopAt('a', 1, 0, 1000)], stopAt('retiro', 2, 0, 1000), {
          schedule: params,
          capacity: { capacityKg: 100, capacityUnits: 3, loads: mapa },
        }),
      );
      // Retirar antes de entregar llevaría 5 unidades a bordo: tiene que ir después.
      expect(r.position).toBe(1);
    });

    it('rechaza cuando la hoja ya tiene el máximo de paradas', () => {
      const r = bestInsertion(ruta, stopAt('c', 3, 0, 1000), {
        schedule: params,
        maxStops: 2,
      });
      expect(r).toEqual({ ok: false, reason: 'max_stops' });
    });
  });

  describe('hoja en curso y paradas fijadas', () => {
    const puntos = recta(2, 4, 6, 3);
    const params = scheduleParams(puntos);

    it('no inserta antes de la posición mínima (la cola pendiente)', () => {
      const ruta = [stopAt('en-camino', 3, 0, 1000), stopAt('b', 2, 0, 1000)];
      const r = ok(
        bestInsertion(
          ruta,
          stopAt('n', 4, 0, 1000),
          { schedule: params },
          { minPosition: 1 },
        ),
      );
      expect(r.position).toBeGreaterThanOrEqual(1);
    });

    it('por omisión no corre una parada fijada: inserta después de la última fijada', () => {
      const ruta = [
        stopAt('a', 1, 0, 1000),
        stopAt('fija', 3, 0, 1000, { locked: true }),
        stopAt('b', 2, 0, 1000),
      ];
      const r = ok(
        bestInsertion(ruta, stopAt('n', 4, 0, 1000), { schedule: params }),
      );
      expect(r.position).toBeGreaterThanOrEqual(2);
      expect(r.shiftedLocked).toEqual([]);
      expect(r.order[1].id).toBe('fija');
    });

    it('con ignoreLocks puede insertar antes y avisa qué fijadas se corrieron', () => {
      const ruta = [
        stopAt('fija', 3, 0, 1000, { locked: true }),
        stopAt('b', 2, 0, 1000),
      ];
      const r = ok(
        bestInsertion(
          ruta,
          stopAt('n', 4, 0, 1000),
          { schedule: params },
          { ignoreLocks: true },
        ),
      );
      expect(r.position).toBe(0);
      expect(r.shiftedLocked).toEqual(['fija']);
    });

    it('con una posición explícita del administrador sólo evalúa ésa, aunque corra una fijada', () => {
      const ruta = [
        stopAt('fija', 3, 0, 1000, { locked: true }),
        stopAt('b', 2, 0, 1000),
      ];
      const r = ok(
        bestInsertion(
          ruta,
          stopAt('n', 4, 0, 1000),
          { schedule: params },
          { position: 0 },
        ),
      );
      expect(r.order.map((s) => s.id)).toEqual(['n', 'fija', 'b']);
      expect(r.shiftedLocked).toEqual(['fija']);
    });

    it('una posición explícita fuera de rango se lleva al borde', () => {
      const ruta = [stopAt('a', 1, 0, 1000)];
      expect(
        ok(
          bestInsertion(
            ruta,
            stopAt('n', 4, 0, 1000),
            { schedule: params },
            { position: 99 },
          ),
        ).position,
      ).toBe(1);
      expect(
        ok(
          bestInsertion(
            ruta,
            stopAt('n', 4, 0, 1000),
            { schedule: params },
            { position: -3 },
          ),
        ).position,
      ).toBe(0);
    });

    it('una posición explícita que rompe una franja se rechaza', () => {
      const ruta = [stopAt('a', 1, 0, 6)];
      const r = bestInsertion(
        ruta,
        stopAt('lejos', 2, 0, 1000),
        { schedule: scheduleParams(recta(2, 40)) },
        { position: 0 },
      );
      expect(r).toEqual({ ok: false, reason: 'window' });
    });
  });

  it('desempata por posición: la primera de las igualmente baratas', () => {
    // Dos paradas en el mismo punto; la nueva, también ahí: da igual dónde, queda primero.
    const puntos = recta(5);
    const ruta = [stopAt('a', 1, 0, 1000), stopAt('b', 1, 0, 1000)];
    const r = ok(
      bestInsertion(ruta, stopAt('n', 1, 0, 1000), {
        schedule: scheduleParams(puntos),
      }),
    );
    expect(r.position).toBe(0);
    // 10 min de manejo y tres paradas de 10 min en el mismo lugar.
    expect(r.schedule.finishMs - T0).toBe(40 * MIN);
  });

  describe('tramo medido en vivo', () => {
    // 0 = posición del chofer, 1 = A a 1 km, 2 = C a 30 km.
    const puntos = recta(1, 30);
    const params = scheduleParams(puntos, {
      firstLeg: { stopId: 'A', minutes: 2, km: 1 },
    });
    const A = stopAt('A', 1, 0, 600);
    const C = stopAt('C', 2, 0, 600);

    it('si la candidata queda primera no hereda el tramo de la otra parada', () => {
      const r = ok(
        bestInsertion([A], C, { schedule: params }, { position: 0 }),
      );
      expect(r.order.map((s) => s.id)).toEqual(['C', 'A']);
      expect(r.schedule.stops[0].legMin).toBeCloseTo(60);
    });

    it('detrás de A, A conserva sus 2 minutos medidos', () => {
      const r = ok(
        bestInsertion([A], C, { schedule: params }, { position: 1 }),
      );
      expect(r.schedule.stops[0].legMin).toBe(2);
    });

    it('elige la posición contando el tramo medido sólo para A', () => {
      const r = ok(bestInsertion([A], C, { schedule: params }));
      expect(r.position).toBe(1);
    });
  });

  describe('entradas inválidas', () => {
    const params = scheduleParams(recta(2, 6));

    it('un id repetido entre la ruta y la candidata se rechaza', () => {
      expect(() =>
        bestInsertion([stopAt('a', 1, 0, 100)], stopAt('a', 2, 0, 100), {
          schedule: params,
        }),
      ).toThrow(InvalidRouteInputError);
    });

    it('una candidata con punto fuera de la matriz o franja invertida se rechaza', () => {
      expect(() =>
        bestInsertion([], stopAt('x', 9, 0, 100), { schedule: params }),
      ).toThrow(InvalidRouteInputError);
      expect(() =>
        bestInsertion([], stopAt('x', 1, 100, 0), { schedule: params }),
      ).toThrow(InvalidRouteInputError);
    });
  });
});
