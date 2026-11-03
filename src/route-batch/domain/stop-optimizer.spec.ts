import { computeSchedule, RouteStop, scoreSchedule } from './eta';
import { InvalidRouteInputError } from './errors/route-sheet.errors';
import {
  MIN,
  permutations,
  scheduleParams,
  seeded,
  stopAt,
  T0,
  XY,
} from './route-fixtures';
import {
  buscarSecuenciaFactible,
  MAX_EXACTO,
  mejorarLocal,
  optimizeStops,
} from './stop-optimizer';

const DEPOSITO: XY = { x: 0, y: 0 };

/** Un caso al azar de `n` paradas con franjas anchas (sólo importa la distancia). */
function casoAlAzar(seed: number, n: number) {
  const azar = seeded(seed);
  const puntos: XY[] = [
    DEPOSITO,
    ...Array.from({ length: n }, () => ({
      x: Math.round(azar() * 200) / 10,
      y: Math.round(azar() * 200) / 10,
    })),
  ];
  const stops = puntos
    .slice(1)
    .map((_, i) => stopAt(`s${i}`, i + 1, 0, 100_000));
  return { puntos, stops, params: scheduleParams(puntos) };
}

const minutosDe = (finishMs: number): number => (finishMs - T0) / MIN;

describe('optimizeStops', () => {
  describe('orden básico', () => {
    it('sobre una recta recorre las paradas de la más cercana a la más lejana', () => {
      const puntos: XY[] = [
        DEPOSITO,
        ...[4, 1, 5, 2, 3].map((x) => ({ x, y: 0 })),
      ];
      const stops = ['x4', 'x1', 'x5', 'x2', 'x3'].map((id, i) =>
        stopAt(id, i + 1, 0, 1000),
      );
      const r = optimizeStops(stops, scheduleParams(puntos));
      expect(r.order).toEqual(['x1', 'x2', 'x3', 'x4', 'x5']);
      expect(r.excluded).toEqual([]);
      expect(r.schedule.feasible).toBe(true);
    });

    it('una restricción externa pesa más que el tiempo: repara el orden que la rompe', () => {
      const puntos: XY[] = [DEPOSITO, ...[1, 2, 3].map((x) => ({ x, y: 0 }))];
      const stops = ['x1', 'x2', 'x3'].map((id, i) =>
        stopAt(id, i + 1, 0, 1000),
      );
      const r = optimizeStops(stops, scheduleParams(puntos), {
        accept: (orden) => orden[0].id === 'x3',
      });
      expect(r.order[0]).toBe('x3');
    });

    it('una sola parada y ninguna parada no rompen nada', () => {
      const p = scheduleParams([DEPOSITO, { x: 3, y: 0 }]);
      expect(optimizeStops([stopAt('a', 1, 0, 500)], p).order).toEqual(['a']);
      const vacio = optimizeStops([], p);
      expect(vacio.order).toEqual([]);
      expect(vacio.schedule.finishMs).toBe(T0);
    });

    it('sale desde el punto de origen que se le diga (la posición del chofer en ruta)', () => {
      const puntos: XY[] = [
        DEPOSITO,
        { x: 10, y: 0 },
        { x: 11, y: 0 },
        { x: 1, y: 0 },
      ];
      const stops = [stopAt('lejos', 1, 0, 1000), stopAt('cerca', 3, 0, 1000)];
      // Parado en el punto 2 (x = 11), lo más cercano es la de x = 10.
      expect(
        optimizeStops(stops, scheduleParams(puntos, { originPoint: 2 })).order,
      ).toEqual(['lejos', 'cerca']);
      expect(optimizeStops(stops, scheduleParams(puntos)).order).toEqual([
        'cerca',
        'lejos',
      ]);
    });
  });

  describe('franjas', () => {
    // P está a 10 km (20 min) y cierra a los 25; Q está a 2 km (4 min) y no apura.
    const puntos: XY[] = [DEPOSITO, { x: 10, y: 0 }, { x: 2, y: 0 }];
    const P = stopAt('P', 1, 0, 25);
    const Q = stopAt('Q', 2, 0, 500);

    it('no deja para después una franja que cierra primero sólo por ahorrar un tramo', () => {
      const r = optimizeStops([Q, P], scheduleParams(puntos));
      expect(r.order).toEqual(['P', 'Q']);
      expect(r.excluded).toEqual([]);
      expect(r.schedule.feasible).toBe(true);
      // P a los 20, sale a los 30, Q a los 46, termina a los 56.
      expect(minutosDe(r.schedule.finishMs)).toBeCloseTo(56);
    });

    it('un orden más corto que rompe una franja jamás se acepta', () => {
      // Q primero termina a los 40 (más corto) pero P llegaría a los 30, tarde.
      const tarde = computeSchedule([Q, P], scheduleParams(puntos));
      expect(minutosDe(tarde.finishMs)).toBeCloseTo(40);
      expect(tarde.lateCount).toBe(1);
      const r = optimizeStops([Q, P], scheduleParams(puntos));
      expect(r.schedule.lateCount).toBe(0);
      expect(minutosDe(r.schedule.finishMs)).toBeGreaterThan(40);
    });

    it('una parada que no llega ni yendo directo sale de la hoja, con el motivo', () => {
      const lejos = stopAt('X', 1, 0, 5); // 10 km = 20 min
      const r = optimizeStops([lejos, Q], scheduleParams(puntos));
      expect(r.excluded).toEqual([{ id: 'X', reason: 'window' }]);
      expect(r.order).toEqual(['Q']);
    });

    it('con la política «keep» la deja al final, marcada tarde', () => {
      const lejos = stopAt('X', 1, 0, 5);
      const r = optimizeStops([lejos, Q], scheduleParams(puntos), {
        lateStops: 'keep',
      });
      expect(r.excluded).toEqual([]);
      expect([...r.order].sort()).toEqual(['Q', 'X']);
      expect(r.schedule.stops.find((s) => s.id === 'X')?.late).toBe(true);
    });

    it('espera a que abra una franja tardía y atiende mientras tanto las que ya abrieron', () => {
      const pts: XY[] = [DEPOSITO, { x: 1, y: 0 }, { x: 2, y: 0 }];
      const tarde = stopAt('tarde', 1, 120, 180);
      const ahora = stopAt('ahora', 2, 0, 100);
      const r = optimizeStops([tarde, ahora], scheduleParams(pts));
      expect(r.order).toEqual(['ahora', 'tarde']);
      expect(r.schedule.feasible).toBe(true);
    });

    it.each(Array.from({ length: 25 }, (_, i) => i + 1))(
      'caso al azar %i con franjas angostas: el resultado nunca tiene paradas tarde y no pierde ninguna',
      (seed) => {
        const azar = seeded(1000 + seed);
        const n = 8;
        const puntos: XY[] = [
          DEPOSITO,
          ...Array.from({ length: n }, () => ({
            x: Math.round(azar() * 100) / 10,
            y: Math.round(azar() * 100) / 10,
          })),
        ];
        // Franjas armadas alrededor de un recorrido de referencia al azar.
        const referencia = Array.from({ length: n }, (_, i) =>
          stopAt(`s${i}`, i + 1, 0, 100_000),
        ).sort(() => azar() - 0.5);
        const params = scheduleParams(puntos);
        const sched = computeSchedule(referencia, params);
        const stops = referencia.map((s, i) =>
          stopAt(
            s.id,
            s.point,
            minutosDe(sched.stops[i].etaMs) - 20,
            minutosDe(sched.stops[i].etaMs) + 20,
          ),
        );
        const r = optimizeStops(stops, params);
        expect(r.schedule.lateCount).toBe(0);
        expect([...r.order, ...r.excluded.map((e) => e.id)].sort()).toEqual(
          stops.map((s) => s.id).sort(),
        );
        // Mejorar nunca empeora al vecino más cercano.
        const sinMejora = optimizeStops(stops, params, { maxMoves: 0 });
        const mismasParadas = sinMejora.excluded.length === r.excluded.length;
        expect(
          !mismasParadas || r.schedule.finishMs <= sinMejora.schedule.finishMs,
        ).toBe(true);
      },
    );
  });

  describe('mejora local (2-opt y Or-opt)', () => {
    it('acorta el recorrido que dejó el vecino más cercano', () => {
      const { stops, params } = casoAlAzar(4, 12);
      const vecino = optimizeStops(stops, params, { maxMoves: 0 });
      const mejorado = optimizeStops(stops, params);
      expect(vecino.moves).toBe(0);
      expect(mejorado.moves).toBeGreaterThan(0);
      expect(mejorado.schedule.finishMs).toBeLessThan(vecino.schedule.finishMs);
      // Lo que ahorra se mide contra la construcción de la que partió, que puede
      // ser mejor que la del vecino más cercano.
      expect(mejorado.savedMinutes).toBeGreaterThan(5);
      expect(mejorado.savedMinutes).toBeGreaterThanOrEqual(
        minutosDe(vecino.schedule.finishMs) -
          minutosDe(mejorado.schedule.finishMs) -
          1e-9,
      );
    });

    it('el tope de movimientos se respeta', () => {
      const { stops, params } = casoAlAzar(4, 7);
      expect(optimizeStops(stops, params, { maxMoves: 1 }).moves).toBe(1);
    });

    it('sin franjas que lo impidan queda a menos de 3 % del óptimo en casos chicos', () => {
      let peor = 1;
      for (let seed = 1; seed <= 30; seed++) {
        const { stops, params } = casoAlAzar(seed, 7);
        const r = optimizeStops(stops, params);
        const mejor = Math.min(
          ...permutations(stops).map(
            (perm) => computeSchedule(perm, params).finishMs,
          ),
        );
        peor = Math.max(peor, (r.schedule.finishMs - T0) / (mejor - T0));
      }
      expect(peor).toBeLessThan(1.03);
    });

    it('con 7 paradas halla el óptimo en la mayoría de los casos', () => {
      let optimos = 0;
      for (let seed = 1; seed <= 30; seed++) {
        const { stops, params } = casoAlAzar(seed, 7);
        const r = optimizeStops(stops, params);
        const mejor = Math.min(
          ...permutations(stops).map(
            (perm) => computeSchedule(perm, params).finishMs,
          ),
        );
        if (Math.abs(r.schedule.finishMs - mejor) < 1) optimos++;
      }
      expect(optimos).toBeGreaterThanOrEqual(22);
    });
  });

  describe('paradas fijadas', () => {
    const puntos: XY[] = [
      DEPOSITO,
      { x: 10, y: 0 },
      { x: 1, y: 0 },
      { x: 3, y: 0 },
      { x: 2, y: 0 },
      { x: 11, y: 0 },
    ];
    const hoja = (): RouteStop[] => [
      stopAt('lejos1', 1, 0, 1000),
      stopAt('cerca1', 2, 0, 1000),
      stopAt('fija', 3, 0, 1000, { locked: true }),
      stopAt('cerca2', 4, 0, 1000),
      stopAt('lejos2', 5, 0, 1000),
    ];

    it('una parada fijada conserva exactamente su posición y las demás se reordenan', () => {
      const r = optimizeStops(hoja(), scheduleParams(puntos));
      expect(r.order[2]).toBe('fija');
      expect([...r.order].sort()).toEqual(
        hoja()
          .map((s) => s.id)
          .sort(),
      );
      // Las libres, solas, quedarían en otro orden (1, 2, 10, 11).
      expect(r.order).not.toEqual(hoja().map((s) => s.id));
    });

    it('fijada en la primera posición, sale primero aunque haya otra más cercana', () => {
      const stops = hoja().map((s) => ({ ...s, locked: s.id === 'lejos2' }));
      const r = optimizeStops(
        [stops[4], stops[0], stops[1], stops[2], stops[3]],
        scheduleParams(puntos),
      );
      expect(r.order[0]).toBe('lejos2');
    });

    it('si la fijada obliga a llegar tarde a otra, ésa sale de la hoja y la fijada se queda', () => {
      const pts: XY[] = [DEPOSITO, { x: 10, y: 0 }, { x: 1, y: 0 }];
      const fija = stopAt('fija', 1, 0, 1000, { locked: true });
      const apurada = stopAt('apurada', 2, 0, 8); // llega a los 2 min si va primero
      const r = optimizeStops([fija, apurada], scheduleParams(pts));
      expect(r.order).toEqual(['fija']);
      // Con paradas fijadas no se prueba la factibilidad: el motivo lo dice.
      expect(r.excluded).toEqual([
        { id: 'apurada', reason: 'window_unverified' },
      ]);
    });

    it('una fijada que llega tarde se queda y se marca tarde (decisión del administrador)', () => {
      const pts: XY[] = [DEPOSITO, { x: 10, y: 0 }];
      const fija = stopAt('fija', 1, 0, 5, { locked: true });
      const r = optimizeStops([fija], scheduleParams(pts));
      expect(r.order).toEqual(['fija']);
      expect(r.excluded).toEqual([]);
      expect(r.schedule.lateCount).toBe(1);
    });

    it('las fijadas cuyo lugar ya no existe quedan donde caben, en el mismo orden', () => {
      const pts: XY[] = [
        DEPOSITO,
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 99, y: 0 },
      ];
      const f1 = stopAt('f1', 1, 0, 1000, { locked: true });
      const f2 = stopAt('f2', 2, 0, 1000, { locked: true });
      const inalcanzable = stopAt('x', 3, 0, 3);
      // f1 estaba en el lugar 1 y f2 en el 3, pero 'x' sale de la hoja.
      const r = optimizeStops([inalcanzable, f1, f2], scheduleParams(pts));
      expect(r.order).toEqual(['f1', 'f2']);
    });
  });

  it('es determinista: el orden de entrada no cambia el resultado', () => {
    const { stops, params } = casoAlAzar(11, 9);
    const base = optimizeStops(stops, params).order;
    for (const semilla of [1, 2, 3]) {
      const azar = seeded(semilla);
      const mezcladas = [...stops].sort(() => azar() - 0.5);
      expect(optimizeStops(mezcladas, params).order).toEqual(base);
    }
  });

  it('los empates de distancia se resuelven por franja, antigüedad e id', () => {
    const pts: XY[] = [
      DEPOSITO,
      { x: 5, y: 0 },
      { x: -5, y: 0 },
      { x: 0, y: 5 },
    ];
    const a = stopAt('a', 1, 0, 1000, { createdAtMs: 300 });
    const b = stopAt('b', 2, 0, 1000, { createdAtMs: 100 });
    const c = stopAt('c', 3, 0, 1000, { createdAtMs: 200 });
    const r = optimizeStops([a, b, c], scheduleParams(pts), { maxMoves: 0 });
    expect(r.order[0]).toBe('b'); // el más antiguo gana el empate
  });

  describe('con el orden que ya tenía la hoja (política keep)', () => {
    it('parte del orden dado si es mejor que el del vecino más cercano', () => {
      // Con franjas angostas y una fija al medio, el orden dado ya es factible.
      const pts: XY[] = [
        DEPOSITO,
        { x: 5, y: 0 },
        { x: 10, y: 0 },
        { x: 15, y: 0 },
      ];
      const dado = [
        stopAt('a', 1, 0, 11),
        stopAt('b', 2, 20, 31),
        stopAt('c', 3, 40, 51),
      ];
      const r = optimizeStops(dado, scheduleParams(pts), { lateStops: 'keep' });
      expect(r.order).toEqual(['a', 'b', 'c']);
      expect(r.schedule.feasible).toBe(true);
    });
  });

  describe('no saca de la hoja una parada que sí entra', () => {
    const PUNTOS: XY[] = [
      DEPOSITO,
      { x: 8.2, y: -6.5 },
      { x: 9.2, y: -2.9 },
      { x: -5, y: 7.7 },
    ];
    const FRANJAS: Array<[number, number]> = [
      [103, 160],
      [111, 166],
      [100, 174],
    ];
    const caso = () => FRANJAS.map(([a, b], i) => stopAt(`s${i}`, i + 1, a, b));

    it('el vecino más cercano sólo la dejaba afuera, y el orden s0 > s1 > s2 es factible', () => {
      const stops = caso();
      const p = scheduleParams(PUNTOS);
      expect(computeSchedule(stops, p).lateCount).toBe(0);
      const r = optimizeStops(stops, p);
      expect(r.excluded).toEqual([]);
      expect(r.schedule.feasible).toBe(true);
      expect([...r.order].sort()).toEqual(['s0', 's1', 's2']);
    });

    it('con más de MAX_EXACTO paradas (heurístico) la reinserción la recupera', () => {
      // El mismo caso, más ocho paradas lejanas con franja amplia que no estorban.
      const lejos = Array.from({ length: 8 }, (_, i) => ({
        x: 40 + i,
        y: 40,
      }));
      const puntos = [...PUNTOS, ...lejos];
      const stops = [
        ...caso(),
        ...lejos.map((_, i) => stopAt(`l${i}`, 4 + i, 600, 900)),
      ];
      const r = optimizeStops(stops, scheduleParams(puntos));
      expect(r.excluded).toEqual([]);
      expect(r.schedule.feasible).toBe(true);
    });

    it('barrido con semilla fija: nunca excluye lo que alguna secuencia cumple, y excluye lo mínimo', () => {
      const azar = seeded(7);
      let factibles = 0;
      for (let it = 0; it < 400; it++) {
        const n = 4 + Math.floor(azar() * 4); // 4 a 7
        const puntos: XY[] = [
          DEPOSITO,
          ...Array.from({ length: n }, () => ({
            x: azar() * 20 - 10,
            y: azar() * 20 - 10,
          })),
        ];
        const stops = Array.from({ length: n }, (_, i) => {
          const desde = Math.floor(azar() * 120);
          return stopAt(
            `s${i}`,
            i + 1,
            desde,
            desde + 30 + Math.floor(azar() * 60),
          );
        });
        const p = scheduleParams(puntos);
        // Fuerza bruta: la mayor cantidad de paradas que alguna secuencia cumple.
        let mejor = 0;
        for (let mascara = 1; mascara < 1 << n; mascara++) {
          const subconjunto = stops.filter((_, i) => mascara & (1 << i));
          if (subconjunto.length <= mejor) continue;
          if (
            permutations(subconjunto).some(
              (o) => computeSchedule(o, p).lateCount === 0,
            )
          ) {
            mejor = subconjunto.length;
          }
        }
        const r = optimizeStops(stops, p);
        expect(n - r.excluded.length).toBe(mejor);
        expect(r.schedule.feasible).toBe(true);
        if (mejor === n) factibles++;
      }
      // El barrido tiene que tener casos factibles de verdad, no sólo imposibles.
      expect(factibles).toBeGreaterThan(100);
    });
  });

  describe('el tramo medido en vivo sólo vale para su parada', () => {
    // 0 = posición del chofer, 1 = A a 1 km, 2 = C a 30 km.
    const puntos: XY[] = [DEPOSITO, { x: 1, y: 0 }, { x: 30, y: 0 }];
    const A = stopAt('A', 1, 0, 600);
    const C = stopAt('C', 2, 0, 600);
    const params = scheduleParams(puntos, {
      firstLeg: { stopId: 'A', minutes: 2, km: 1 },
    });

    it('si A queda primera usa los 2 minutos medidos', () => {
      const s = computeSchedule([A, C], params);
      expect(s.stops[0].legMin).toBe(2);
    });

    it('si C queda primera NO toma los 2 minutos: usa la matriz', () => {
      const s = computeSchedule([C, A], params);
      expect(s.stops[0].legMin).toBeCloseTo(60);
    });

    it('el optimizador no le regala el tramo en vivo a la que queda primera', () => {
      const r = optimizeStops([C, A], params, { lateStops: 'keep' });
      const primera = r.schedule.stops[0];
      expect(primera.id).toBe('A');
      expect(primera.legMin).toBe(2);
      const forzada = optimizeStops([{ ...C, locked: true }, A], params, {
        lateStops: 'keep',
      });
      expect(forzada.order[0]).toBe('C');
      expect(forzada.schedule.stops[0].legMin).toBeCloseTo(60);
    });
  });

  describe('entradas inválidas', () => {
    const puntos: XY[] = [DEPOSITO, { x: 5, y: 0 }, { x: 10, y: 0 }];
    const p = scheduleParams(puntos);

    it('una franja invertida es un error de dominio', () => {
      expect(() => optimizeStops([stopAt('a', 1, 300, 200)], p)).toThrow(
        InvalidRouteInputError,
      );
    });

    it('una franja con NaN es un error de dominio', () => {
      const mala = { ...stopAt('a', 1, 0, 100), windowStartMs: NaN };
      expect(() => optimizeStops([mala], p)).toThrow(InvalidRouteInputError);
    });

    it('un punto fuera de la matriz es un error de dominio, no un TypeError', () => {
      expect(() => optimizeStops([stopAt('a', 9, 0, 600)], p)).toThrow(
        InvalidRouteInputError,
      );
      expect(() => optimizeStops([stopAt('a', -1, 0, 600)], p)).toThrow(
        InvalidRouteInputError,
      );
    });

    it('un id repetido se rechaza', () => {
      expect(() =>
        optimizeStops([stopAt('a', 1, 0, 600), stopAt('a', 2, 0, 600)], p),
      ).toThrow(InvalidRouteInputError);
    });

    it('un origen fuera de la matriz se rechaza', () => {
      expect(() =>
        optimizeStops([stopAt('a', 1, 0, 600)], { ...p, originPoint: 7 }),
      ).toThrow(InvalidRouteInputError);
    });
  });

  describe('la mejora local no rompe una franja que se cumplía', () => {
    const PUNTOS: XY[] = [
      DEPOSITO,
      { x: 1.19, y: 2.44 },
      { x: 7.69, y: 9.23 },
      { x: 1.96, y: 2.07 },
      { x: 1.46, y: -0.26 },
      { x: -8.11, y: 3.03 },
      { x: 3.02, y: 9.91 },
    ];
    const FRANJAS: Array<[number, number]> = [
      [85, 111],
      [16, 68],
      [116, 153],
      [111, 149],
      [91, 143],
      [8, 42],
    ];
    const stops = FRANJAS.map(([a, b], i) => stopAt(`s${i}`, i + 1, a, b));
    const p = scheduleParams(PUNTOS);
    const ctx = {
      calidad: (o: readonly RouteStop[]) => {
        const sc = scoreSchedule(o, p);
        return {
          invalid: 0,
          late: sc.lateCount,
          finishMs: sc.finishMs,
          km: sc.totalKm,
        };
      },
      tardias: (o: readonly RouteStop[]) =>
        new Set(
          computeSchedule(o, p)
            .stops.filter((s) => s.late)
            .map((s) => s.id),
        ),
      maxMovimientos: 50,
    };

    it('el conjunto de tardías del resultado está dentro del de la partida', () => {
      const partida = ctx.tardias(stops);
      expect([...partida].sort()).toEqual(['s1', 's3', 's4', 's5']);
      const r = mejorarLocal(stops, ctx);
      expect(r.moves).toBeGreaterThan(0);
      for (const id of ctx.tardias(r.actual))
        expect(partida.has(id)).toBe(true);
    });

    it('sin la regla, el mismo caso deja tarde a s0, que llegaba en franja', () => {
      const r = mejorarLocal(stops, ctx, false);
      expect(ctx.tardias(r.actual).has('s0')).toBe(true);
    });
  });

  describe('de 9 a 12 paradas: la búsqueda de factibilidad evita las exclusiones falsas', () => {
    /** Los casos que el vecino más cercano + la mejora local dejaban con una parada afuera sin motivo. */
    const CASOS: Array<{
      nombre: string;
      puntos: Array<[number, number]>;
      franjas: Array<[number, number]>;
    }> = [
      {
        nombre: '9 paradas',
        puntos: [
          [0, 0],
          [-7.72, -1.53],
          [-7.83, -6.27],
          [-1.04, 0.74],
          [-2.48, -8.06],
          [-1.59, 4.38],
          [-5.93, 3.26],
          [-5.81, 7.56],
          [4.63, 2.98],
          [2.73, -4.56],
        ],
        franjas: [
          [70, 150],
          [155, 209],
          [88, 132],
          [130, 201],
          [23, 71],
          [94, 134],
          [55, 152],
          [139, 212],
          [165, 261],
        ],
      },
      {
        nombre: '10 paradas',
        puntos: [
          [0, 0],
          [1.37, 7.03],
          [-7.37, -9.11],
          [4.98, -0.55],
          [-2.99, -5.25],
          [9.89, 0.34],
          [0.75, 7.03],
          [0.77, -0.15],
          [3.05, 7.36],
          [6.1, -0.8],
          [-1.22, -2.78],
        ],
        franjas: [
          [95, 178],
          [6, 87],
          [176, 268],
          [79, 171],
          [70, 121],
          [50, 135],
          [140, 232],
          [183, 277],
          [126, 215],
          [6, 57],
        ],
      },
      {
        nombre: '12 paradas',
        puntos: [
          [0, 0],
          [-4.96, 2.16],
          [-8.78, 9.03],
          [1.48, -5.01],
          [-5.68, 5.33],
          [-4.98, 2.5],
          [7.73, -1.39],
          [-2.87, -4.04],
          [-8.37, 6.72],
          [-3.84, -5.24],
          [-4.77, 7.82],
          [-3.81, -7.04],
          [-4.75, 7.38],
        ],
        franjas: [
          [138, 189],
          [50, 118],
          [163, 257],
          [193, 291],
          [67, 146],
          [164, 261],
          [129, 220],
          [29, 110],
          [61, 157],
          [139, 238],
          [102, 151],
          [66, 134],
        ],
      },
    ];
    const armar = (c: (typeof CASOS)[number]) => ({
      puntos: c.puntos.map(([x, y]) => ({ x, y })),
      stops: c.franjas.map(([a, b], i) => stopAt(`s${i}`, i + 1, a, b)),
    });

    it.each(CASOS)('$nombre: entra toda la hoja, en franja', (caso) => {
      const { puntos, stops } = armar(caso);
      const p = scheduleParams(puntos);
      expect(buscarSecuenciaFactible(stops, p).estado).toBe('found');
      const r = optimizeStops(stops, p);
      expect(r.excluded).toEqual([]);
      expect(r.order).toHaveLength(stops.length);
      expect(r.schedule.feasible).toBe(true);
    });

    it('la secuencia que encuentra la búsqueda es en franja, y si no hay ninguna lo dice', () => {
      const { puntos, stops } = armar(CASOS[0]);
      const p = scheduleParams(puntos);
      const f = buscarSecuenciaFactible(stops, p);
      expect(f.orden).toHaveLength(stops.length);
      expect(computeSchedule(f.orden, p).lateCount).toBe(0);
      const imposible = [...stops, stopAt('x', 9, 0, 1)];
      expect(
        buscarSecuenciaFactible(
          imposible,
          scheduleParams([...puntos, puntos[9]]),
        ).estado,
      ).toBe('none');
      expect(buscarSecuenciaFactible([], p)).toEqual({
        estado: 'found',
        orden: [],
        nodos: 0,
      });
    });

    it('con el tope de nodos agotado no afirma que no entra: el motivo es window_unverified', () => {
      const { puntos, stops } = armar(CASOS[0]);
      const p = scheduleParams(puntos);
      expect(buscarSecuenciaFactible(stops, p, 1).estado).toBe('unknown');
      const r = optimizeStops(stops, p, { maxSearchNodes: 1 });
      expect(r.excluded).toEqual([{ id: 's1', reason: 'window_unverified' }]);
    });

    it('una parada que de verdad no llega queda afuera con motivo window (probado)', () => {
      const { puntos, stops } = armar(CASOS[0]);
      const lejos = { x: 30, y: 30 };
      const r = optimizeStops(
        [...stops, stopAt('x', 10, 0, 1)],
        scheduleParams([...puntos, lejos]),
      );
      expect(r.excluded).toEqual([{ id: 'x', reason: 'window' }]);
      expect(r.schedule.feasible).toBe(true);
    });

    it('barrido de 9 a 12 paradas contra la búsqueda completa: cero exclusiones falsas', () => {
      let factibles = 0;
      for (const n of [9, 10, 11, 12]) {
        const azar = seeded(100 + n);
        let casos = 0;
        for (let it = 0; it < 5000 && casos < 40; it++) {
          const puntos: XY[] = [
            DEPOSITO,
            ...Array.from({ length: n }, () => ({
              x: azar() * 20 - 10,
              y: azar() * 20 - 10,
            })),
          ];
          const stops = Array.from({ length: n }, (_, i) => {
            const desde = Math.floor(azar() * 200);
            return stopAt(
              `s${i}`,
              i + 1,
              desde,
              desde + 40 + Math.floor(azar() * 60),
            );
          });
          const p = scheduleParams(puntos);
          const referencia = buscarSecuenciaFactible(stops, p, 5_000_000);
          if (referencia.estado !== 'found') continue;
          casos++;
          factibles++;
          const r = optimizeStops(stops, p);
          expect(r.excluded).toEqual([]);
          expect(r.order).toHaveLength(n);
          expect(r.schedule.feasible).toBe(true);
        }
        expect(casos).toBe(40);
      }
      expect(factibles).toBe(160);
    });

    it(`hasta ${MAX_EXACTO} paradas la búsqueda exacta resuelve sola; con una más depende del tope de nodos`, () => {
      const exclusiones = (n: number): number => {
        const azar = seeded(300 + n);
        let total = 0;
        let casos = 0;
        for (let it = 0; it < 8000 && casos < 120; it++) {
          const puntos: XY[] = [
            DEPOSITO,
            ...Array.from({ length: n }, () => ({
              x: azar() * 20 - 10,
              y: azar() * 20 - 10,
            })),
          ];
          const stops = Array.from({ length: n }, (_, i) => {
            const desde = Math.floor(azar() * 200);
            return stopAt(
              `s${i}`,
              i + 1,
              desde,
              desde + 40 + Math.floor(azar() * 60),
            );
          });
          const p = scheduleParams(puntos);
          if (buscarSecuenciaFactible(stops, p, 5_000_000).estado !== 'found') {
            continue;
          }
          casos++;
          total += optimizeStops(stops, p, { maxSearchNodes: 1 }).excluded
            .length;
        }
        expect(casos).toBe(120);
        return total;
      };
      expect(exclusiones(MAX_EXACTO)).toBe(0);
      expect(exclusiones(MAX_EXACTO + 1)).toBeGreaterThan(0);
    });
  });

  /** Sólo hasta MAX_EXACTO paradas el optimizador saca por capacidad; con más lo hace `planFleet`. */
  describe('lo que no entra por la capacidad sale con su propio motivo', () => {
    const puntos: XY[] = [DEPOSITO, ...[1, 2, 3, 4].map((x) => ({ x, y: 0 }))];
    const stops = ['a', 'b', 'c', 'd'].map((id, i) =>
      stopAt(id, i + 1, 0, 1000),
    );
    const sinC = (orden: readonly RouteStop[]) =>
      !orden.some((s) => s.id === 'c');

    it('en franja entraría, pero el vehículo no la lleva: capacity', () => {
      const r = optimizeStops(stops, scheduleParams(puntos), { accept: sinC });
      expect(r.order).toEqual(['a', 'b', 'd']);
      expect(r.excluded).toEqual([{ id: 'c', reason: 'capacity' }]);
    });

    it('y si además no llega en franja, el motivo es la franja', () => {
      const lejos: XY[] = [
        DEPOSITO,
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 50, y: 0 },
      ];
      const r = optimizeStops(
        [
          stopAt('a', 1, 0, 1000),
          stopAt('b', 2, 0, 1000),
          stopAt('c', 3, 0, 1),
        ],
        scheduleParams(lejos),
        { accept: sinC },
      );
      expect(r.excluded).toEqual([{ id: 'c', reason: 'window' }]);
    });
  });

  describe('modo keep: ninguna parada sale de la hoja', () => {
    const puntos: XY[] = [
      DEPOSITO,
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 80, y: 0 },
    ];

    it('una parada que no llega se queda, marcada tarde, y no se pierde del orden', () => {
      const stops = [
        stopAt('a', 1, 0, 1000),
        stopAt('b', 2, 0, 1000),
        stopAt('lejos', 3, 0, 5),
      ];
      const r = optimizeStops(stops, scheduleParams(puntos), {
        lateStops: 'keep',
      });
      expect([...r.order].sort()).toEqual(['a', 'b', 'lejos']);
      expect(r.excluded).toEqual([]);
      expect(r.schedule.stops.find((s) => s.id === 'lejos')?.late).toBe(true);
    });

    it('con más paradas que MAX_EXACTO también se conservan todas', () => {
      const muchos: XY[] = [
        DEPOSITO,
        ...Array.from({ length: 10 }, (_, i) => ({ x: i + 1, y: 0 })),
        { x: 80, y: 0 },
      ];
      const stops = [
        ...muchos.slice(1, 11).map((_, i) => stopAt(`s${i}`, i + 1, 0, 1000)),
        stopAt('lejos', 11, 0, 5),
      ];
      const r = optimizeStops(stops, scheduleParams(muchos), {
        lateStops: 'keep',
      });
      expect(r.order).toHaveLength(11);
      expect(r.schedule.stops.filter((s) => s.late).map((s) => s.id)).toEqual([
        'lejos',
      ]);
    });
  });

  describe('el tramo medido en vivo en la búsqueda exacta y en la heurística', () => {
    // 0 = posición del chofer, 1 = A a 1 km (2 min en la matriz), 2 = C a 30 km.
    // El tramo medido hasta A es de 20 min (embotellamiento): A no llega en su franja.
    const puntos: XY[] = [DEPOSITO, { x: 1, y: 0 }, { x: 30, y: 0 }];
    const A = stopAt('A', 1, 0, 10);
    const C = stopAt('C', 2, 0, 600);
    const params = scheduleParams(puntos, {
      firstLeg: { stopId: 'A', minutes: 20, km: 1 },
    });

    it('hasta MAX_EXACTO: A queda afuera porque con el tramo medido llegaría tarde', () => {
      const r = optimizeStops([A, C], params);
      expect(r.excluded).toEqual([{ id: 'A', reason: 'window' }]);
      expect(r.schedule.feasible).toBe(true);
    });

    it('con más de MAX_EXACTO paradas pasa lo mismo y el resto no hereda el tramo', () => {
      const muchos: XY[] = [...puntos];
      const resto = Array.from({ length: 9 }, (_, i) => {
        muchos.push({ x: 31 + i, y: 0 });
        return stopAt(`r${i}`, 3 + i, 0, 600);
      });
      const r = optimizeStops(
        [A, C, ...resto],
        scheduleParams(muchos, {
          firstLeg: { stopId: 'A', minutes: 20, km: 1 },
        }),
      );
      expect(r.excluded).toEqual([{ id: 'A', reason: 'window' }]);
      expect(r.schedule.feasible).toBe(true);
      expect(r.schedule.stops[0].legMin).toBeGreaterThan(20);
    });

    it('la búsqueda de factibilidad también respeta que el tramo medido es sólo de A', () => {
      expect(buscarSecuenciaFactible([A, C], params).estado).toBe('none');
      const holgada = scheduleParams(puntos, {
        firstLeg: { stopId: 'A', minutes: 2, km: 1 },
      });
      expect(
        buscarSecuenciaFactible([A, stopAt('C2', 2, 0, 600)], holgada).estado,
      ).toBe('found');
      // C a 30 km no puede ir primera con el tramo de A: 60 min > 40.
      expect(
        buscarSecuenciaFactible([stopAt('C3', 2, 0, 40)], holgada).estado,
      ).toBe('none');
    });
  });

  describe('casos fijos que distinguen cada pieza del optimizador', () => {
    const caso = (
      pts: Array<[number, number]>,
      franjas: Array<[number, number]>,
      locked: number[] = [],
    ) => ({
      puntos: pts.map(([x, y]) => ({ x, y })),
      stops: franjas.map(([a, b], i) =>
        stopAt(`s${i}`, i + 1, a, b, { locked: locked.includes(i) }),
      ),
    });
    const minutos = (ms: number): number => (ms - T0) / MIN;

    it('el tramo medido en vivo cuenta en la búsqueda exacta: el resultado es el óptimo con ese tramo', () => {
      const { puntos, stops } = caso(
        [
          [0, 0],
          [3.61, 2.2],
          [-9.89, 6.14],
          [-7.99, -1.23],
          [-1.28, 3.88],
          [8.31, -1.73],
          [2.42, 9.17],
        ],
        [
          [11, 67],
          [83, 175],
          [52, 101],
          [27, 125],
          [58, 157],
          [78, 123],
        ],
      );
      const r = optimizeStops(
        stops,
        scheduleParams(puntos, {
          firstLeg: { stopId: 's0', minutes: 34.3077, km: 3.12 },
        }),
      );
      expect(r.excluded).toEqual([{ id: 's2', reason: 'window' }]);
      expect(r.order).toEqual(['s3', 's0', 's4', 's5', 's1']);
      expect(minutos(r.schedule.finishMs)).toBeCloseTo(149.74, 1);
    });

    it('la construcción por inserción deja menos paradas afuera cuando las franjas son angostas', () => {
      const { puntos, stops } = caso(
        [
          [0, 0],
          [8.87, -9.31],
          [8.5, -9.29],
          [7.39, 8.19],
          [-4.78, -4.11],
          [3.05, -9.03],
          [0.25, 9.15],
          [-8.62, -8.21],
          [-7.51, -7.61],
          [-1.7, -6.54],
          [1.35, -8.47],
          [2.46, -3.93],
          [-1.68, -4.63],
        ],
        [
          [90, 167],
          [148, 188],
          [172, 249],
          [62, 109],
          [181, 222],
          [94, 141],
          [100, 135],
          [163, 237],
          [182, 223],
          [48, 111],
          [90, 156],
          [140, 190],
        ],
      );
      const r = optimizeStops(stops, scheduleParams(puntos));
      expect(r.excluded.length).toBeLessThanOrEqual(3);
      expect(r.schedule.feasible).toBe(true);
    });

    it('la búsqueda de factibilidad usa el tramo medido sólo para su parada, aun cuando otra tenga un tramo de entrada corto', () => {
      // 0 salida, 1 = A (en la hoja anterior, no está), 2 = C a 30 km, 3 = B a 29 km de C... a 1 km de C.
      const pts: XY[] = [
        DEPOSITO,
        { x: 1, y: 0 },
        { x: 30, y: 0 },
        { x: 29, y: 0 },
      ];
      const p = scheduleParams(pts, {
        firstLeg: { stopId: 'A', minutes: 2, km: 1 },
      });
      const C = stopAt('C', 2, 0, 40);
      const B = stopAt('B', 3, 0, 600);
      // C primera tardaría 60 min con la matriz (> 40); B primera y C después, más.
      expect(buscarSecuenciaFactible([C, B], p).estado).toBe('none');
      // Con el tramo medido (2 min) hasta C sí entraría: es lo que NO se debe usar.
      const medido = scheduleParams(pts, {
        firstLeg: { stopId: 'C', minutes: 2, km: 1 },
      });
      expect(buscarSecuenciaFactible([C, B], medido).estado).toBe('found');
    });
  });

  describe('con paradas fijadas ninguna parada libre queda tarde dentro de la hoja', () => {
    const libresTarde = (r: ReturnType<typeof optimizeStops>): string[] => {
      const fijas = new Set(r.stops.filter((s) => s.locked).map((s) => s.id));
      return r.schedule.stops
        .filter((s) => s.late && !fijas.has(s.id))
        .map((s) => s.id);
    };

    it('el caso concreto: la fijada s2 en el índice 2 no le pasa su tardanza a s0', () => {
      const puntos: XY[] = [
        DEPOSITO,
        { x: -6, y: -4 },
        { x: 6, y: 7 },
        { x: -3, y: 0 },
        { x: -6, y: -6 },
        { x: -5, y: -7 },
      ];
      const stops = [
        stopAt('s0', 1, 40, 70),
        stopAt('s1', 2, 20, 40),
        stopAt('s2', 3, 0, 25, { locked: true }),
        stopAt('s3', 4, 10, 45),
        stopAt('s4', 5, 20, 55),
      ];
      const r = optimizeStops(stops, scheduleParams(puntos));
      expect(libresTarde(r)).toEqual([]);
      expect(r.order).toContain('s2');
      // Lo que no entra queda afuera, con el motivo de que no se pudo probar.
      for (const e of r.excluded) expect(e.reason).toBe('window_unverified');
      expect(r.order.length + r.excluded.length).toBe(5);
    });

    it('barrido con fijadas al azar: cero paradas libres tarde en modo exclude', () => {
      const azar = seeded(41);
      let conFijadas = 0;
      for (let it = 0; it < 600; it++) {
        const n = 4 + Math.floor(azar() * 7); // 4 a 10
        const puntos: XY[] = [
          DEPOSITO,
          ...Array.from({ length: n }, () => ({
            x: azar() * 20 - 10,
            y: azar() * 20 - 10,
          })),
        ];
        const cuantas = 1 + Math.floor(azar() * 2);
        const fijas = new Set<number>();
        while (fijas.size < cuantas) fijas.add(Math.floor(azar() * n));
        const stops = Array.from({ length: n }, (_, i) => {
          const desde = Math.floor(azar() * 120);
          return stopAt(
            `s${i}`,
            i + 1,
            desde,
            desde + 20 + Math.floor(azar() * 60),
            {
              locked: fijas.has(i),
            },
          );
        });
        const r = optimizeStops(stops, scheduleParams(puntos));
        expect(libresTarde(r)).toEqual([]);
        expect(r.order.length + r.excluded.length).toBe(n);
        conFijadas++;
      }
      expect(conFijadas).toBe(600);
    });
  });

  describe('más de 52 paradas: la búsqueda de factibilidad no corre', () => {
    const N = 53;
    const puntos: XY[] = [
      DEPOSITO,
      ...Array.from({ length: N }, (_, i) => ({ x: i + 1, y: 0 })),
    ];
    const stops = puntos
      .slice(1)
      .map((_, i) => stopAt(`s${i}`, i + 1, 0, 100_000));

    it('devuelve unknown (la máscara de bits sólo llega a 52)', () => {
      const p = scheduleParams(puntos);
      expect(buscarSecuenciaFactible(stops.slice(0, 52), p).estado).toBe(
        'found',
      );
      expect(buscarSecuenciaFactible(stops, p)).toEqual({
        estado: 'unknown',
        orden: [],
        nodos: 0,
      });
    });

    it('una parada imposible entre 53 queda afuera sin probar, no como window', () => {
      const conImposible = [...stops.slice(0, 52), stopAt('x', 53, 0, 1)];
      const r = optimizeStops(conImposible, scheduleParams(puntos), {
        maxMoves: 0,
      });
      expect(r.excluded).toEqual([{ id: 'x', reason: 'window_unverified' }]);
      expect(r.schedule.feasible).toBe(true);
    });
  });
});
