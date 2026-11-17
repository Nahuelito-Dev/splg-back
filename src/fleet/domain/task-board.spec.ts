import {
  BoardColumn,
  BoardMoveTarget,
  calcularPosicion,
  columnaDe,
  EstadoDeTarea,
  PASO_DE_POSICION,
  renumerar,
  resolverMovimiento,
} from './task-board';

const TURNO = new Date('2026-12-02T13:00:00.000Z');
const tarea = (status: EstadoDeTarea, scheduledAt: Date | null = null) => ({
  status,
  scheduledAt,
});

describe('columnaDe', () => {
  it.each([
    ['forecast', null, BoardColumn.FORECAST],
    ['scheduled', TURNO, BoardColumn.SCHEDULED],
    ['in_progress', TURNO, BoardColumn.IN_PROGRESS],
    ['done', TURNO, BoardColumn.DONE],
    ['overdue', null, BoardColumn.FORECAST],
    ['overdue', TURNO, BoardColumn.SCHEDULED],
    ['cancelled', TURNO, null],
  ] as const)('%s (turno %s) → %s', (status, turno, columna) => {
    expect(columnaDe(tarea(status, turno))).toBe(columna);
  });
});

describe('resolverMovimiento: la máquina de estados del tablero', () => {
  const { FORECAST, SCHEDULED, IN_PROGRESS } = BoardMoveTarget;

  it.each([
    // origen, turno guardado, destino, con turno nuevo, resultado
    ['forecast', null, SCHEDULED, true, 'scheduled', 'fijar'],
    ['scheduled', TURNO, FORECAST, false, 'forecast', 'borrar'],
    ['scheduled', TURNO, IN_PROGRESS, false, 'in_progress', 'conservar'],
    ['in_progress', TURNO, SCHEDULED, false, 'scheduled', 'conservar'],
    ['in_progress', TURNO, SCHEDULED, true, 'scheduled', 'fijar'],
    ['overdue', null, SCHEDULED, true, 'scheduled', 'fijar'],
    ['overdue', TURNO, IN_PROGRESS, false, 'in_progress', 'conservar'],
  ] as const)(
    'válida: %s → %s',
    (origen, guardado, destino, conTurno, estado, turno) => {
      expect(
        resolverMovimiento(tarea(origen, guardado), destino, conTurno),
      ).toEqual({ ok: true, estado, turno });
    },
  );

  it.each([
    ['forecast', null, FORECAST, false, 'conservar'],
    ['scheduled', TURNO, SCHEDULED, false, 'conservar'],
    ['scheduled', TURNO, SCHEDULED, true, 'fijar'],
    ['in_progress', TURNO, IN_PROGRESS, false, 'conservar'],
    ['overdue', TURNO, SCHEDULED, false, 'conservar'],
  ] as const)(
    'misma columna (%s) sólo reordena: el estado no cambia',
    (origen, guardado, destino, conTurno, turno) => {
      expect(
        resolverMovimiento(tarea(origen, guardado), destino, conTurno),
      ).toEqual({ ok: true, estado: null, turno });
    },
  );

  it.each([
    ['forecast', null, IN_PROGRESS],
    ['in_progress', TURNO, FORECAST],
    ['overdue', null, IN_PROGRESS],
  ] as const)('no permitida: %s → %s', (origen, guardado, destino) => {
    expect(resolverMovimiento(tarea(origen, guardado), destino, false)).toEqual(
      { ok: false, motivo: 'transicion_no_permitida' },
    );
  });

  it.each(['done', 'cancelled'] as const)(
    'desde %s no se mueve a ninguna columna',
    (origen) => {
      for (const destino of Object.values(BoardMoveTarget)) {
        expect(
          resolverMovimiento(tarea(origen, TURNO), destino, false),
        ).toEqual({ ok: false, motivo: 'cerrada' });
      }
    },
  );

  it('forecast → scheduled sin turno: falta el turno', () => {
    expect(resolverMovimiento(tarea('forecast'), SCHEDULED, false)).toEqual({
      ok: false,
      motivo: 'falta_el_turno',
    });
  });

  it.each([FORECAST, IN_PROGRESS])(
    'un turno con destino %s está fuera de lugar',
    (destino) => {
      expect(
        resolverMovimiento(tarea('scheduled', TURNO), destino, true),
      ).toEqual({ ok: false, motivo: 'turno_fuera_de_lugar' });
    },
  );
});

describe('calcularPosicion: orden fraccional', () => {
  const columna = [
    { id: 'a', position: 1024 },
    { id: 'b', position: 2048 },
    { id: 'c', position: 3072 },
  ];

  it('sin vecinas va al final', () => {
    expect(calcularPosicion(columna, {})).toEqual({ ok: true, posicion: 4096 });
  });

  it('en una columna vacía arranca en el primer paso', () => {
    expect(calcularPosicion([], {})).toEqual({
      ok: true,
      posicion: PASO_DE_POSICION,
    });
  });

  it('después de una: entre esa y la siguiente', () => {
    expect(calcularPosicion(columna, { afterId: 'a' })).toEqual({
      ok: true,
      posicion: 1536,
    });
  });

  it('después de la última: un paso más', () => {
    expect(calcularPosicion(columna, { afterId: 'c' })).toEqual({
      ok: true,
      posicion: 4096,
    });
  });

  it('antes de una: entre la anterior y esa', () => {
    expect(calcularPosicion(columna, { beforeId: 'c' })).toEqual({
      ok: true,
      posicion: 2560,
    });
  });

  it('antes de la primera: un paso menos', () => {
    expect(calcularPosicion(columna, { beforeId: 'a' })).toEqual({
      ok: true,
      posicion: 0,
    });
  });

  it('entre dos: el punto medio', () => {
    expect(calcularPosicion(columna, { afterId: 'a', beforeId: 'c' })).toEqual({
      ok: true,
      posicion: 2048,
    });
  });

  it('dos vecinas al revés se rechazan', () => {
    expect(calcularPosicion(columna, { afterId: 'c', beforeId: 'a' })).toEqual({
      ok: false,
      motivo: 'vecinas_invertidas',
    });
  });

  it('sin hueco entre las vecinas pide renumerar', () => {
    expect(
      calcularPosicion(
        [
          { id: 'a', position: 1 },
          { id: 'b', position: 1 + 1e-9 },
        ],
        { afterId: 'a' },
      ),
    ).toEqual({ ok: false, motivo: 'renumerar' });
  });

  it('una vecina sin posición pide renumerar', () => {
    expect(
      calcularPosicion(
        [
          { id: 'a', position: 1024 },
          { id: 'b', position: null },
        ],
        { afterId: 'a' },
      ),
    ).toEqual({ ok: false, motivo: 'renumerar' });
  });

  it('renumerar deja la columna pareja en su orden', () => {
    expect(
      renumerar([
        { id: 'x', position: 1 },
        { id: 'y', position: 1 + 1e-9 },
        { id: 'z', position: null },
      ]),
    ).toEqual([
      { id: 'x', position: 1024 },
      { id: 'y', position: 2048 },
      { id: 'z', position: 3072 },
    ]);
  });
});
