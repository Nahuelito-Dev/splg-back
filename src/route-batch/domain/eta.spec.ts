import {
  computeSchedule,
  estimatedWindow,
  MINUTOS_ENTRE_AVISOS,
  notificationFor,
} from './eta';
import { MIN, scheduleParams, stopAt, T0 } from './route-fixtures';

// Depósito en (0,0); a 30 km/h, 5 km son 10 minutos.
const PUNTOS = [
  { x: 0, y: 0 },
  { x: 5, y: 0 },
  { x: 5, y: 5 },
];

describe('computeSchedule', () => {
  const params = scheduleParams(PUNTOS);

  it('encadena tramo, servicio y tramo: llega a los 10 y a los 30 minutos', () => {
    const s = computeSchedule(
      [stopAt('a', 1, 0, 120), stopAt('b', 2, 0, 120)],
      params,
    );
    expect(s.stops.map((x) => x.etaMs)).toEqual([T0 + 10 * MIN, T0 + 30 * MIN]);
    expect(s.stops.map((x) => x.departMs)).toEqual([
      T0 + 20 * MIN,
      T0 + 40 * MIN,
    ]);
    expect(s.finishMs).toBe(T0 + 40 * MIN);
    expect(s.totalKm).toBeCloseTo(10);
    expect(s.travelMin).toBeCloseTo(20);
    expect(s.feasible).toBe(true);
    expect(s.lateCount).toBe(0);
    expect(s.stops.map((x) => x.sequence)).toEqual([1, 2]);
  });

  it('si llega antes de que abra la franja, espera hasta que abre', () => {
    const s = computeSchedule([stopAt('a', 1, 60, 120)], params);
    expect(s.stops[0].etaMs).toBe(T0 + 60 * MIN);
    expect(s.stops[0].waitMin).toBeCloseTo(50);
    expect(s.finishMs).toBe(T0 + 70 * MIN);
  });

  it('la espera de una parada corre la hora de todas las siguientes', () => {
    const s = computeSchedule(
      [stopAt('a', 1, 60, 120), stopAt('b', 2, 0, 120)],
      params,
    );
    // a: 60 -> sale 70 -> b: 70 + 10 de manejo = 80.
    expect(s.stops[1].etaMs).toBe(T0 + 80 * MIN);
  });

  it('si llega después de que cierra la franja queda marcada tarde, con los minutos de atraso', () => {
    const s = computeSchedule([stopAt('a', 1, 0, 4)], params);
    expect(s.stops[0].late).toBe(true);
    expect(s.stops[0].lateMin).toBeCloseTo(6);
    expect(s.lateCount).toBe(1);
    expect(s.feasible).toBe(false);
  });

  it('llegar justo al cierre de la franja no es llegar tarde', () => {
    const s = computeSchedule([stopAt('a', 1, 0, 10)], params);
    expect(s.stops[0].late).toBe(false);
    expect(s.feasible).toBe(true);
  });

  it('el primer tramo medido en vivo reemplaza al de la matriz', () => {
    const s = computeSchedule([stopAt('a', 1, 0, 120)], {
      ...params,
      firstLeg: { stopId: 'a', minutes: 3, km: 1.5 },
    });
    expect(s.stops[0].etaMs).toBe(T0 + 3 * MIN);
    expect(s.stops[0].legKm).toBe(1.5);
    expect(s.totalKm).toBe(1.5);
  });

  it('el tramo en vivo sólo vale para la primera parada', () => {
    const s = computeSchedule(
      [stopAt('a', 1, 0, 120), stopAt('b', 2, 0, 120)],
      {
        ...params,
        firstLeg: { stopId: 'a', minutes: 3, km: 1.5 },
      },
    );
    // a: 3 -> sale 13 -> b: 13 + 10 (de la matriz) = 23
    expect(s.stops[1].etaMs).toBe(T0 + 23 * MIN);
    expect(s.stops[1].legKm).toBeCloseTo(5);
  });

  it('puede salir de otro punto que el depósito (la posición del chofer en ruta)', () => {
    const s = computeSchedule([stopAt('b', 2, 0, 120)], {
      ...params,
      originPoint: 1,
    });
    expect(s.stops[0].etaMs).toBe(T0 + 10 * MIN);
  });

  it('una hoja vacía termina cuando sale', () => {
    const s = computeSchedule([], params);
    expect(s.stops).toEqual([]);
    expect(s.finishMs).toBe(T0);
    expect(s.feasible).toBe(true);
    expect(s.totalKm).toBe(0);
  });

  it('el servicio configurado mueve las horas', () => {
    const s = computeSchedule(
      [stopAt('a', 1, 0, 120), stopAt('b', 2, 0, 120)],
      {
        ...params,
        serviceMinutes: 20,
      },
    );
    expect(s.stops[1].etaMs).toBe(T0 + 40 * MIN); // 10 + 20 + 10
  });
});

describe('estimatedWindow', () => {
  const SLOT = { start: T0 + 120 * MIN, end: T0 + 240 * MIN };

  it('arma ± la mitad del ancho alrededor de la hora estimada', () => {
    const eta = T0 + 180 * MIN;
    expect(estimatedWindow(eta, SLOT.start, SLOT.end, 30)).toEqual({
      startMs: eta - 30 * MIN,
      endMs: eta + 30 * MIN,
      outsideSlot: false,
    });
  });

  it('nunca promete antes de que abra la franja comprada', () => {
    const w = estimatedWindow(SLOT.start + 10 * MIN, SLOT.start, SLOT.end, 30);
    expect(w.startMs).toBe(SLOT.start);
    expect(w.endMs).toBe(SLOT.start + 40 * MIN);
    expect(w.outsideSlot).toBe(false);
  });

  it('ni después de que cierra', () => {
    const w = estimatedWindow(SLOT.end - 10 * MIN, SLOT.start, SLOT.end, 30);
    expect(w.startMs).toBe(SLOT.end - 40 * MIN);
    expect(w.endMs).toBe(SLOT.end);
  });

  it('si la hora estimada ya se fue de la franja dice la verdad, sin recortar, y lo marca', () => {
    const eta = SLOT.end + 25 * MIN;
    expect(estimatedWindow(eta, SLOT.start, SLOT.end, 30)).toEqual({
      startMs: eta - 30 * MIN,
      endMs: eta + 30 * MIN,
      outsideSlot: true,
    });
  });

  it('antes de abrir la franja también es «afuera»', () => {
    expect(
      estimatedWindow(SLOT.start - MIN, SLOT.start, SLOT.end, 30).outsideSlot,
    ).toBe(true);
  });
});

describe('notificationFor', () => {
  const SLOT = { startMs: T0 + 120 * MIN, endMs: T0 + 240 * MIN };
  const ventana = (centroMin: number) =>
    estimatedWindow(T0 + centroMin * MIN, SLOT.startMs, SLOT.endMs, 30);
  const avisada = (centroMin: number, hace: number) => {
    const w = ventana(centroMin);
    return {
      startMs: w.startMs,
      endMs: w.endMs,
      notifiedAtMs: T0 - hace * MIN,
    };
  };
  const ahora = T0;

  it('el primer aviso sale siempre', () => {
    expect(notificationFor(ventana(180), null, SLOT, ahora, 15)).toEqual({
      notify: true,
      reason: 'first',
    });
  });

  it('avisa si la franja se corrió el mínimo configurado', () => {
    expect(
      notificationFor(ventana(195), avisada(180, 60), SLOT, ahora, 15),
    ).toEqual({ notify: true, reason: 'shifted' });
  });

  it('no avisa por un corrimiento menor al mínimo', () => {
    expect(
      notificationFor(ventana(194), avisada(180, 60), SLOT, ahora, 15),
    ).toEqual({ notify: false, reason: null });
  });

  it('avisa también si se corrió hacia adelante', () => {
    expect(
      notificationFor(ventana(160), avisada(180, 60), SLOT, ahora, 15).notify,
    ).toBe(true);
  });

  it('no avisa dos veces con menos de diez minutos de diferencia, aunque se haya corrido mucho', () => {
    expect(MINUTOS_ENTRE_AVISOS).toBe(10);
    expect(
      notificationFor(ventana(220), avisada(180, 9), SLOT, ahora, 15),
    ).toEqual({ notify: false, reason: null });
    expect(
      notificationFor(ventana(220), avisada(180, 10), SLOT, ahora, 15).notify,
    ).toBe(true);
  });

  it('avisa cuando la hora estimada sale de la franja comprada', () => {
    const afuera = ventana(260);
    expect(afuera.outsideSlot).toBe(true);
    expect(notificationFor(afuera, avisada(235, 60), SLOT, ahora, 120)).toEqual(
      { notify: true, reason: 'outside_slot' },
    );
  });

  it('si ya se le avisó que salía de la franja, sólo vuelve a avisar por corrimiento', () => {
    const previa = avisada(260, 60);
    expect(notificationFor(ventana(265), previa, SLOT, ahora, 15).notify).toBe(
      false,
    );
    expect(notificationFor(ventana(280), previa, SLOT, ahora, 15).reason).toBe(
      'shifted',
    );
  });

  it('un movimiento de la hora estimada que el recorte a la franja no deja ver no genera aviso', () => {
    // Antes de abrir la franja la ventana se recorta al inicio: 121 y 125 se ven igual.
    const a = ventana(121);
    const b = ventana(125);
    expect(a.startMs).toBe(b.startMs);
    expect(
      notificationFor(
        b,
        { startMs: a.startMs, endMs: a.endMs, notifiedAtMs: T0 - 60 * MIN },
        SLOT,
        ahora,
        15,
      ).notify,
    ).toBe(false);
  });
});
