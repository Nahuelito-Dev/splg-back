import {
  ProcessHealth,
  ProcessName,
  ProcessRunStatus,
} from './process-catalog';
import { evaluarSalud, proximaEsperada } from './process-health';

const AHORA = new Date('2026-11-03T12:00:00Z');
const haceSeg = (s: number) => new Date(AHORA.getTime() - s * 1000);
// FLEET_PLANNER_DAILY corre cada hora: período 3600 s, atraso a partir de 5400 s.
const P = ProcessName.FLEET_PLANNER_DAILY;

describe('evaluarSalud', () => {
  it('sin corridas es never', () => {
    expect(evaluarSalud(null, P, AHORA, 30)).toBe(ProcessHealth.NEVER);
  });

  it.each([
    [5400, ProcessHealth.OK],
    [5401, ProcessHealth.LATE],
  ])(
    'una corrida ok de hace %i s es %s (el borde de 1,5 períodos no es atraso)',
    (seg, esperado) => {
      expect(
        evaluarSalud(
          { status: ProcessRunStatus.OK, startedAt: haceSeg(seg) },
          P,
          AHORA,
          30,
        ),
      ).toBe(esperado);
    },
  );

  it('una parcial a tiempo es partial y una atrasada es late', () => {
    const u = (seg: number) => ({
      status: ProcessRunStatus.PARTIAL,
      startedAt: haceSeg(seg),
    });
    expect(evaluarSalud(u(60), P, AHORA, 30)).toBe(ProcessHealth.PARTIAL);
    expect(evaluarSalud(u(6000), P, AHORA, 30)).toBe(ProcessHealth.LATE);
  });

  it('una fallida es failed aunque esté atrasada', () => {
    expect(
      evaluarSalud(
        { status: ProcessRunStatus.FAILED, startedAt: haceSeg(99999) },
        P,
        AHORA,
        30,
      ),
    ).toBe(ProcessHealth.FAILED);
  });

  it.each([
    [1800, ProcessHealth.RUNNING],
    [1801, ProcessHealth.STUCK],
  ])(
    'una corrida running hace %i s con máximo de 30 min es %s',
    (seg, esperado) => {
      expect(
        evaluarSalud(
          { status: ProcessRunStatus.RUNNING, startedAt: haceSeg(seg) },
          P,
          AHORA,
          30,
        ),
      ).toBe(esperado);
    },
  );

  it('un proceso de alta frecuencia se espera según su período de registro', () => {
    // dispatch_tick corre cada 15 s pero se registra cada 5 min: atraso a los 450 s.
    const u = (seg: number) => ({
      status: ProcessRunStatus.OK,
      startedAt: haceSeg(seg),
    });
    expect(evaluarSalud(u(450), ProcessName.DISPATCH_TICK, AHORA, 30)).toBe(
      ProcessHealth.OK,
    );
    expect(evaluarSalud(u(451), ProcessName.DISPATCH_TICK, AHORA, 30)).toBe(
      ProcessHealth.LATE,
    );
  });

  it('la próxima corrida esperada es el inicio más el período', () => {
    expect(proximaEsperada(haceSeg(0), P).toISOString()).toBe(
      '2026-11-03T13:00:00.000Z',
    );
  });
});
