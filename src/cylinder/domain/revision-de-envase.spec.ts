import { CylinderInspectionResult } from './cylinder-inspection-result';
import { finDelDia, inicioDelDia } from './dia-calendario';
import { ReglaDeEnvaseError } from './errors/cylinder-rule.errors';
import { planificarRevision } from './revision-de-envase';

describe('planificarRevision', () => {
  // Mediodía del 15/10 en Buenos Aires.
  const ahora = new Date('2026-10-15T15:00:00.000Z');

  it('la revisión es de un día de calendario y el envase vale hasta el final del día de vencimiento', () => {
    expect(
      planificarRevision(
        {
          inspectedAt: '2026-10-14',
          result: CylinderInspectionResult.APPROVED,
          nextDueAt: '2031-10-14T10:00:00.000Z',
          notes: 'ok',
        },
        ahora,
      ),
    ).toEqual({
      inspectedAt: inicioDelDia('2026-10-14'),
      vence: finDelDia('2031-10-14'),
      rechazada: false,
      result: CylinderInspectionResult.APPROVED,
      notes: 'ok',
    });
  });

  it('la revisión puede ser de hoy, pero no de mañana', () => {
    const datos = (inspectedAt: string) => ({
      inspectedAt,
      result: CylinderInspectionResult.APPROVED,
      nextDueAt: '2031-01-01',
    });
    expect(() => planificarRevision(datos('2026-10-15'), ahora)).not.toThrow();
    expect(() => planificarRevision(datos('2026-10-16'), ahora)).toThrow(
      'La fecha de la revisión no puede ser futura',
    );
  });

  it('"hoy" es el día argentino: a las 22:00 de Buenos Aires todavía no es mañana', () => {
    // 01:00 UTC del 16/10 = 22:00 del 15/10 en Buenos Aires.
    const noche = new Date('2026-10-16T01:00:00.000Z');
    expect(() =>
      planificarRevision(
        {
          inspectedAt: '2026-10-16',
          result: CylinderInspectionResult.REJECTED,
        },
        noche,
      ),
    ).toThrow(ReglaDeEnvaseError);
  });

  it('si no es un rechazo exige el próximo vencimiento, posterior a la revisión', () => {
    const base = {
      inspectedAt: '2026-10-14',
      result: CylinderInspectionResult.CONDITIONAL,
    };
    expect(() => planificarRevision(base, ahora)).toThrow(
      'La fecha del próximo vencimiento es obligatoria',
    );
    expect(() =>
      planificarRevision({ ...base, nextDueAt: '2026-10-14' }, ahora),
    ).toThrow('El vencimiento tiene que ser posterior');
  });

  it('en un rechazo el próximo vencimiento se ignora', () => {
    expect(
      planificarRevision(
        {
          inspectedAt: '2026-10-14',
          result: CylinderInspectionResult.REJECTED,
          nextDueAt: '2031-10-14',
        },
        ahora,
      ),
    ).toMatchObject({ rechazada: true, vence: null, notes: null });
  });
});
