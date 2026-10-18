import {
  agregarNota,
  duracionEnMinutos,
  validarJornada,
} from './attendance-rules';

describe('reglas de la asistencia', () => {
  const ingreso = new Date('2026-03-02T11:00:00Z');

  it('el egreso tiene que ser posterior al ingreso', () => {
    expect(validarJornada(ingreso, new Date('2026-03-02T11:00:00Z'))).toBe(
      'EGRESO_NO_POSTERIOR',
    );
    expect(validarJornada(ingreso, new Date('2026-03-02T10:59:00Z'))).toBe(
      'EGRESO_NO_POSTERIOR',
    );
    expect(
      validarJornada(ingreso, new Date('2026-03-02T11:00:01Z')),
    ).toBeNull();
    expect(validarJornada(ingreso, null)).toBeNull();
  });

  it('la duración es null mientras la jornada está abierta', () => {
    expect(duracionEnMinutos(ingreso, null)).toBeNull();
    expect(duracionEnMinutos(ingreso, new Date('2026-03-02T19:30:59Z'))).toBe(
      510,
    );
  });

  it('las notas de corrección se acumulan', () => {
    expect(agregarNota(null, 'Olvidó marcar')).toBe('Olvidó marcar');
    expect(agregarNota('Olvidó marcar', 'Cambia egreso')).toBe(
      'Olvidó marcar\nCambia egreso',
    );
  });
});
