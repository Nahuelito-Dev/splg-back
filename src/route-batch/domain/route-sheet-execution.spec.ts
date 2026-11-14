import { RouteStop, ScheduleParams, computeSchedule } from './eta';
import { RouteBatchStatus } from './route-batch.enums';
import {
  colaConDesvio,
  faltantesDeCarga,
  franjaAbierta,
  hojaTerminada,
  diaDeReprogramacion,
  diaHabilSiguiente,
  esperaVencida,
  insertarEnCola,
  metrosEntre,
  motivoParaNoIniciar,
  ordenCompleto,
  partirRecorrido,
  progresoDeParada,
  reordenarCola,
  reintentosAlFinal,
  resultadoDelIntento,
  siguienteParada,
  tocaRecalcular,
} from './route-sheet-execution';
import { CALENDARIO_POR_OMISION, diasDeLaMascara } from './calendario-laboral';

const MIN = 60_000;

/** Matriz de una línea: el punto i está a i×10 minutos (y i km) del origen. */
function enLinea(n: number): ScheduleParams {
  const minutes: number[][] = [];
  const km: number[][] = [];
  for (let a = 0; a <= n; a++) {
    minutes.push([]);
    km.push([]);
    for (let b = 0; b <= n; b++) {
      minutes[a].push(Math.abs(a - b) * 10);
      km[a].push(Math.abs(a - b));
    }
  }
  return {
    matrix: { minutes, km },
    originPoint: 0,
    startMs: 0,
    serviceMinutes: 0,
  };
}

const stop = (id: string, point: number, ventana?: [number, number]) =>
  ({
    id,
    point,
    windowStartMs: (ventana?.[0] ?? 0) * MIN,
    windowEndMs: (ventana?.[1] ?? 10_000) * MIN,
  }) as RouteStop;

describe('progresoDeParada', () => {
  it.each([
    [true, null, 'pending', 'pending'],
    [true, null, 'accepted', 'pending'],
    [true, null, 'on_the_way', 'on_the_way'],
    [true, null, 'delivered', 'delivered'],
    [false, 'failed_delivery', 'pending', 'failed'],
    [false, 'needs_reschedule', 'pending', 'failed'],
    [false, 'rescheduled', 'pending', 'failed'],
    [false, null, 'delivered', 'delivered'],
    [false, null, 'pending', 'removed'],
    [false, 'cancelled', 'cancelled', 'removed'],
    [false, 'sheet_closed', 'pending', 'removed'],
    [false, 'reassigned', 'accepted', 'removed'],
  ] as const)(
    'activa=%s motivo=%s pedido=%s → %s',
    (active, removedReason, estado, esperado) => {
      expect(progresoDeParada({ active, removedReason }, estado)).toBe(
        esperado,
      );
    },
  );

  it('sin pedido (no se ve) es pendiente si está activa', () => {
    expect(progresoDeParada({ active: true, removedReason: null }, null)).toBe(
      'pending',
    );
  });
});

describe('partirRecorrido / siguienteParada / hojaTerminada / ordenCompleto', () => {
  const r = partirRecorrido([
    { orderId: 'a', progress: 'delivered' },
    { orderId: 'b', progress: 'pending' },
    { orderId: 'c', progress: 'on_the_way' },
    { orderId: 'd', progress: 'on_the_way' },
    { orderId: 'e', progress: 'failed' },
    { orderId: 'f', progress: 'pending' },
  ]);

  it('separa hechas, la (única) en camino y las pendientes; las que salieron no cuentan', () => {
    expect(r).toEqual({
      hechas: ['a'],
      enCamino: 'c',
      pendientes: ['b', 'd', 'f'],
    });
  });

  it('la siguiente es la en camino o, si no hay, la primera pendiente', () => {
    expect(siguienteParada(r)).toBe('c');
    expect(
      siguienteParada({ hechas: [], enCamino: null, pendientes: ['x'] }),
    ).toBe('x');
    expect(
      siguienteParada({ hechas: ['a'], enCamino: null, pendientes: [] }),
    ).toBeNull();
  });

  it('terminada cuando no hay en camino ni pendientes', () => {
    expect(hojaTerminada(r)).toBe(false);
    expect(
      hojaTerminada({ hechas: ['a'], enCamino: null, pendientes: [] }),
    ).toBe(true);
    expect(hojaTerminada({ hechas: [], enCamino: 'c', pendientes: [] })).toBe(
      false,
    );
    expect(
      hojaTerminada({ hechas: [], enCamino: null, pendientes: ['b'] }),
    ).toBe(false);
  });

  it('orden completo: hechas, en camino, cola', () => {
    expect(ordenCompleto(r, ['f', 'b'])).toEqual(['a', 'c', 'f', 'b']);
    expect(
      ordenCompleto({ hechas: [], enCamino: null, pendientes: [] }, ['x']),
    ).toEqual(['x']);
  });
});

describe('reordenarCola', () => {
  const params = enLinea(4);

  it('ordena la cola por cercanía y deja primera y fija la que está en camino', () => {
    // El chofer va hacia la 4 (lejos): igual va primera; el resto se ordena después.
    const stops = [stop('p1', 1), stop('p3', 3), stop('p4', 4), stop('p2', 2)];
    const cola = reordenarCola(stops, params, 'p4');
    expect(cola).not.toContain('p4');
    expect(cola).toHaveLength(3);
    // Desde la 4 lo mejor es volver: 3, 2, 1.
    expect(cola).toEqual(['p3', 'p2', 'p1']);
  });

  it('sin parada en camino, ordena todo', () => {
    const stops = [stop('p3', 3), stop('p1', 1), stop('p2', 2)];
    expect(reordenarCola(stops, params, null)).toEqual(['p1', 'p2', 'p3']);
  });

  it('con una sola (o ninguna) en la cola no hay nada que ordenar', () => {
    expect(reordenarCola([stop('p1', 1)], params, null)).toEqual(['p1']);
    expect(reordenarCola([stop('p4', 4), stop('p1', 1)], params, 'p4')).toEqual(
      ['p1'],
    );
    expect(reordenarCola([], params, null)).toEqual([]);
  });

  it('no saca de la hoja las que llegan tarde: las deja al final', () => {
    // p2 cierra a los 5 minutos: imposible; sigue en la cola.
    const stops = [stop('p1', 1), stop('p2', 2, [0, 5]), stop('p3', 3)];
    const cola = reordenarCola(stops, params, null);
    expect([...cola].sort()).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('insertarEnCola', () => {
  const params = enLinea(5);

  it('sin posición: donde menos atrasa, nunca antes de la parada en camino', () => {
    const cola = [stop('p1', 1), stop('p4', 4)];
    // En camino a la 2: la 3 entra entre la 2 y la 4 (después de la 1 sería volver).
    const r = insertarEnCola(stop('p2', 2), cola, stop('p3', 3), params);
    expect(r).not.toContain('p2');
    expect(r).toHaveLength(3);
    const conCamino = [
      stop('p2', 2),
      ...r.map((id) => cola.find((s) => s.id === id) ?? stop('p3', 3)),
    ];
    const fin = computeSchedule(conCamino, params).finishMs;
    for (const alt of [
      ['p3', 'p1', 'p4'],
      ['p1', 'p3', 'p4'],
      ['p1', 'p4', 'p3'],
    ]) {
      const s = [
        stop('p2', 2),
        ...alt.map((id) =>
          id === 'p3'
            ? stop('p3', 3)
            : (cola.find((x) => x.id === id) as RouteStop),
        ),
      ];
      expect(fin).toBeLessThanOrEqual(computeSchedule(s, params).finishMs);
    }
  });

  it('prefiere la posición que no deja paradas tarde aunque termine más tarde', () => {
    // La nueva (punto 1) cierra a los 15 minutos: tiene que ir primera.
    const cola = [stop('p5', 5)];
    const r = insertarEnCola(null, cola, stop('n1', 1, [0, 15]), params);
    expect(r).toEqual(['n1', 'p5']);
  });

  it('a igualdad de tardanza y fin, menos kilómetros', () => {
    const flat: ScheduleParams = {
      matrix: {
        minutes: [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ],
        km: [
          [0, 5, 1],
          [5, 0, 5],
          [1, 5, 0],
        ],
      },
      originPoint: 0,
      startMs: 0,
      serviceMinutes: 0,
    };
    expect(insertarEnCola(null, [stop('a', 1)], stop('n', 2), flat)).toEqual([
      'n',
      'a',
    ]);
  });

  it('con posición: ahí (1 = la próxima), recortada a los extremos', () => {
    const cola = [stop('p1', 1), stop('p2', 2)];
    expect(insertarEnCola(null, cola, stop('n', 3), params, 1)).toEqual([
      'n',
      'p1',
      'p2',
    ]);
    expect(insertarEnCola(null, cola, stop('n', 3), params, 2)).toEqual([
      'p1',
      'n',
      'p2',
    ]);
    expect(insertarEnCola(null, cola, stop('n', 3), params, 99)).toEqual([
      'p1',
      'p2',
      'n',
    ]);
    expect(insertarEnCola(null, cola, stop('n', 3), params, 0)).toEqual([
      'n',
      'p1',
      'p2',
    ]);
  });

  it('con la cola vacía, sola', () => {
    expect(insertarEnCola(stop('c', 1), [], stop('n', 2), params)).toEqual([
      'n',
    ]);
  });
});

describe('colaConDesvio', () => {
  it('la elegida pasa adelante y el resto conserva su orden', () => {
    expect(colaConDesvio(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(colaConDesvio(['a', 'b'], 'a')).toEqual(['a', 'b']);
  });
});

describe('faltantesDeCarga', () => {
  it('lo que pide la hoja menos lo que tiene el camión, sólo lo que falta', () => {
    const r = faltantesDeCarga(
      [
        { gasCylinderId: 'g10', type: '10 kg', units: 5 },
        { gasCylinderId: 'g15', type: '15 kg', units: 2 },
        { gasCylinderId: 'g45', type: '45 kg', units: 1 },
      ],
      new Map([
        ['g10', 3],
        ['g15', 2],
      ]),
    );
    expect(r).toEqual([
      {
        gasCylinderId: 'g10',
        type: '10 kg',
        required: 5,
        onTruck: 3,
        missing: 2,
      },
      {
        gasCylinderId: 'g45',
        type: '45 kg',
        required: 1,
        onTruck: 0,
        missing: 1,
      },
    ]);
  });

  it('sin faltantes, vacío', () => {
    expect(
      faltantesDeCarga(
        [{ gasCylinderId: 'g', type: null, units: 1 }],
        new Map([['g', 4]]),
      ),
    ).toEqual([]);
  });
});

describe('motivoParaNoIniciar', () => {
  const base = {
    status: RouteBatchStatus.CONFIRMED,
    planDate: '2026-11-14',
    hoy: '2026-11-14',
    sheetDeliveryId: 'd1',
    actorDeliveryId: 'd1' as string | null,
  };

  it('confirmada, de hoy y de su chofer: se puede', () => {
    expect(motivoParaNoIniciar(base)).toBeNull();
  });

  it('el admin (sin chofer actor) la inicia en su nombre', () => {
    expect(motivoParaNoIniciar({ ...base, actorDeliveryId: null })).toBeNull();
  });

  it('otro chofer: wrong_driver (antes que cualquier otra cosa)', () => {
    expect(
      motivoParaNoIniciar({
        ...base,
        actorDeliveryId: 'd2',
        status: RouteBatchStatus.DRAFT,
      }),
    ).toBe('wrong_driver');
  });

  it.each([
    RouteBatchStatus.DRAFT,
    RouteBatchStatus.COMPLETED,
    RouteBatchStatus.DISSOLVED,
  ])('en %s no se inicia', (status) => {
    expect(motivoParaNoIniciar({ ...base, status })).toBe('not_confirmed');
  });

  it('de otro día no se inicia', () => {
    expect(motivoParaNoIniciar({ ...base, planDate: '2026-11-15' })).toBe(
      'not_today',
    );
    expect(motivoParaNoIniciar({ ...base, planDate: '2026-11-13' })).toBe(
      'not_today',
    );
  });
});

describe('franjaAbierta', () => {
  it('abierta antes del fin; cerrada en el fin o después; sin franja, abierta', () => {
    expect(franjaAbierta(1000, 999)).toBe(true);
    expect(franjaAbierta(1000, 1000)).toBe(false);
    expect(franjaAbierta(1000, 2000)).toBe(false);
    expect(franjaAbierta(null, 5)).toBe(true);
  });
});

describe('metrosEntre / tocaRecalcular', () => {
  const posadas = { lat: -27.3671, lng: -55.8961 };

  it('mide en metros (un minuto de latitud ≈ 1852 m)', () => {
    expect(metrosEntre(posadas, posadas)).toBe(0);
    const d = metrosEntre({ lat: 0, lng: 0 }, { lat: 1 / 60, lng: 0 });
    expect(d).toBeGreaterThan(1840);
    expect(d).toBeLessThan(1860);
  });

  it('la primera vez siempre', () => {
    expect(tocaRecalcular(null, posadas, 0, 120, 300)).toBe(true);
  });

  it('nunca antes del piso, aunque se haya movido mucho', () => {
    const u = { atMs: 0, ...posadas };
    expect(
      tocaRecalcular(u, { lat: -27.4, lng: -55.9 }, 14_000, 120, 300),
    ).toBe(false);
  });

  it('pasado el mínimo de segundos, sí (aunque no se mueva)', () => {
    const u = { atMs: 0, ...posadas };
    expect(tocaRecalcular(u, posadas, 120_000, 120, 300)).toBe(true);
    expect(tocaRecalcular(u, posadas, 119_000, 120, 300)).toBe(false);
  });

  it('antes del mínimo, sólo si se movió los metros del parámetro', () => {
    const u = { atMs: 0, ...posadas };
    const cerca = { lat: posadas.lat + 0.001, lng: posadas.lng }; // ~111 m
    const lejos = { lat: posadas.lat + 0.003, lng: posadas.lng }; // ~333 m
    expect(tocaRecalcular(u, cerca, 30_000, 120, 300)).toBe(false);
    expect(tocaRecalcular(u, lejos, 30_000, 120, 300)).toBe(true);
  });

  it('el piso se puede cambiar', () => {
    const u = { atMs: 0, ...posadas };
    expect(tocaRecalcular(u, posadas, 5_000, 4, 300, 1)).toBe(true);
  });
});

describe('reintentos y espera en la puerta (rediseño del 14/11)', () => {
  it('lo que ya falló una vez va al final, en el orden en que falló («el 3 pasa a ser el 10»)', () => {
    expect(
      reintentosAlFinal(
        ['a', 'r2', 'b', 'r1', 'c'],
        new Map([
          ['r1', 100],
          ['r2', 200],
        ]),
      ),
    ).toEqual(['a', 'b', 'c', 'r1', 'r2']);
    // Mismo momento: conserva el orden que traía.
    expect(
      reintentosAlFinal(
        ['r2', 'x', 'r1'],
        new Map([
          ['r1', 5],
          ['r2', 5],
        ]),
      ),
    ).toEqual(['x', 'r2', 'r1']);
    expect(reintentosAlFinal(['a', 'b'], new Map())).toEqual(['a', 'b']);
  });

  it('el día hábil siguiente: el día de después, salteando el domingo', () => {
    expect(diaHabilSiguiente('2026-11-16')).toBe('2026-11-17'); // lunes → martes
    expect(diaHabilSiguiente('2026-11-14')).toBe('2026-11-16'); // sábado → lunes
    expect(diaHabilSiguiente('2026-11-15')).toBe('2026-11-16'); // domingo → lunes
    expect(diaHabilSiguiente('2026-12-31')).toBe('2027-01-01');
  });

  it('primer intento fallido vuelve a la cola; el segundo se reprograma', () => {
    expect(resultadoDelIntento(0)).toBe('requeued');
    expect(resultadoDelIntento(1)).toBe('rescheduled');
    expect(resultadoDelIntento(2)).toBe('rescheduled');
  });

  it('la espera vence a los arrivalWaitMinutes de «Llegué»; sin «Llegué», nunca', () => {
    expect(esperaVencida(0, 9 * 60_000, 10)).toBe(false);
    expect(esperaVencida(0, 10 * 60_000, 10)).toBe(true);
    expect(esperaVencida(null, 99 * 60_000, 10)).toBe(false);
  });
});

describe('diaDeReprogramacion', () => {
  const AHORA = Date.parse('2026-11-16T15:00:00Z');
  const plan = (status: string, cutoffMs: number) => ({ status, cutoffMs });

  it('sin plan todavía: el día hábil siguiente (sábado → lunes)', () => {
    expect(diaDeReprogramacion('2026-11-16', new Map(), AHORA)).toBe(
      '2026-11-17',
    );
    expect(diaDeReprogramacion('2026-11-14', new Map(), AHORA)).toBe(
      '2026-11-16',
    );
  });

  it('mañana ya propuesto, cerrado o con el cierre vencido: el siguiente hábil abierto', () => {
    expect(
      diaDeReprogramacion(
        '2026-11-16',
        new Map([['2026-11-17', plan('proposed', AHORA - 1)]]),
        AHORA,
      ),
    ).toBe('2026-11-18');
    expect(
      diaDeReprogramacion(
        '2026-11-20',
        new Map([
          ['2026-11-21', plan('open', AHORA - 1)],
          ['2026-11-23', plan('closed', AHORA - 1)],
        ]),
        AHORA,
      ),
    ).toBe('2026-11-24'); // sábado vencido, domingo no cuenta, lunes cerrado → martes
  });

  it('saltea los feriados y los días que la distribuidora no reparte', () => {
    // Lunes a viernes, con el martes 17/11 feriado: del lunes 16 al miércoles 18.
    const cal = {
      diasHabiles: diasDeLaMascara(31),
      feriados: new Set(['2026-11-17']),
    };
    expect(diaDeReprogramacion('2026-11-16', new Map(), AHORA, cal)).toBe(
      '2026-11-18',
    );
    // Del viernes 20 (sin sábado) al lunes 23; con el lunes propuesto, martes 24.
    expect(diaDeReprogramacion('2026-11-20', new Map(), AHORA, cal)).toBe(
      '2026-11-23',
    );
    expect(
      diaDeReprogramacion(
        '2026-11-20',
        new Map([['2026-11-23', plan('proposed', AHORA - 1)]]),
        AHORA,
        cal,
      ),
    ).toBe('2026-11-24');
  });

  it('abierto con el cierre por delante sirve; sin día válido en el horizonte, null (nunca una fecha sin verificar)', () => {
    expect(
      diaDeReprogramacion(
        '2026-11-16',
        new Map([['2026-11-17', plan('open', AHORA + 1)]]),
        AHORA,
      ),
    ).toBe('2026-11-17');
    const todos = new Map(
      ['2026-11-17', '2026-11-18'].map((d) => [d, plan('closed', 0)] as const),
    );
    expect(
      diaDeReprogramacion(
        '2026-11-16',
        todos,
        AHORA,
        CALENDARIO_POR_OMISION,
        2,
      ),
    ).toBeNull();
  });

  it('sólo lunes y los lunes ocupados: el primer lunes libre; todos ocupados en 60 días, null', () => {
    const soloLunes = {
      diasHabiles: diasDeLaMascara(1),
      feriados: new Set<string>(),
    };
    const lunes = (desde: string, n: number) =>
      Array.from({ length: n }, (_, i) => {
        const d = new Date(`${desde}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 7 * i);
        return d.toISOString().slice(0, 10);
      });
    // Lunes 23/11 y 30/11 propuestos: el 7/12.
    const dos = new Map(
      lunes('2026-11-23', 2).map((d) => [d, plan('proposed', 0)] as const),
    );
    expect(diaDeReprogramacion('2026-11-16', dos, AHORA, soloLunes)).toBe(
      '2026-12-07',
    );
    // Los 9 lunes de los próximos 60 días ocupados: no hay día.
    const nueve = new Map(
      lunes('2026-11-23', 9).map((d) => [d, plan('closed', 0)] as const),
    );
    expect(
      diaDeReprogramacion('2026-11-16', nueve, AHORA, soloLunes),
    ).toBeNull();
    // Con un horizonte que llega al lunes siguiente (25/01, a 70 días), ese.
    expect(diaDeReprogramacion('2026-11-16', nueve, AHORA, soloLunes, 70)).toBe(
      '2027-01-25',
    );
  });
});
