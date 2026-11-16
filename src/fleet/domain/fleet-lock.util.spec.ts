import { MaintenanceCriticality } from '../entities/maintenance-plan.entity';
import { ExpirationStatus } from './expiration-status';
import {
  describirVencimiento,
  estaInhabilitado,
  formatearFechaUtc,
  normalizarFechaCalendario,
  tareasQueInhabilitan,
} from './fleet-lock.util';

describe('estaInhabilitado', () => {
  it('sin tareas, no está inhabilitado', () => {
    expect(estaInhabilitado([])).toBe(false);
  });

  it('una bloqueante vencida inhabilita', () => {
    expect(
      estaInhabilitado([
        {
          criticality: MaintenanceCriticality.BLOCKING,
          expirationStatus: ExpirationStatus.EXPIRED,
        },
      ]),
    ).toBe(true);
  });

  it('una bloqueante por vencer todavía no inhabilita', () => {
    expect(
      estaInhabilitado([
        {
          criticality: MaintenanceCriticality.BLOCKING,
          expirationStatus: ExpirationStatus.DUE_SOON,
        },
      ]),
    ).toBe(false);
  });

  it('una no bloqueante vencida (service) no inhabilita', () => {
    expect(
      estaInhabilitado([
        {
          criticality: MaintenanceCriticality.NON_BLOCKING,
          expirationStatus: ExpirationStatus.EXPIRED,
        },
      ]),
    ).toBe(false);
  });

  it('alcanza con que UNA de varias esté vencida y bloquee', () => {
    expect(
      estaInhabilitado([
        {
          criticality: MaintenanceCriticality.NON_BLOCKING,
          expirationStatus: ExpirationStatus.EXPIRED,
        },
        {
          criticality: MaintenanceCriticality.BLOCKING,
          expirationStatus: ExpirationStatus.CURRENT,
        },
        {
          criticality: MaintenanceCriticality.BLOCKING,
          expirationStatus: ExpirationStatus.EXPIRED,
        },
      ]),
    ).toBe(true);
  });
});

describe('tareasQueInhabilitan', () => {
  it('devuelve sólo las bloqueantes vencidas, preservando los campos extra del caller', () => {
    const vencida = {
      id: 't1',
      criticality: MaintenanceCriticality.BLOCKING,
      expirationStatus: ExpirationStatus.EXPIRED,
    };
    const porVencer = {
      id: 't2',
      criticality: MaintenanceCriticality.BLOCKING,
      expirationStatus: ExpirationStatus.DUE_SOON,
    };
    const noBloqueanteVencida = {
      id: 't3',
      criticality: MaintenanceCriticality.NON_BLOCKING,
      expirationStatus: ExpirationStatus.EXPIRED,
    };

    expect(
      tareasQueInhabilitan([vencida, porVencer, noBloqueanteVencida]),
    ).toEqual([vencida]);
  });

  it('sin ninguna inhabilitante, devuelve vacío', () => {
    expect(
      tareasQueInhabilitan([
        {
          criticality: MaintenanceCriticality.BLOCKING,
          expirationStatus: ExpirationStatus.CURRENT,
        },
      ]),
    ).toEqual([]);
  });
});

describe('formatearFechaUtc', () => {
  it('lee los componentes UTC, no la zona horaria del server', () => {
    // Con el server en America/Cordoba (UTC-3), toLocaleDateString('es-AR')
    // mostraba 31/12/2019 para esta misma fecha (el bug que reportó la
    // revisión): esta función no depende de la zona horaria del proceso.
    expect(formatearFechaUtc(new Date('2020-01-01T00:00:00.000Z'))).toBe(
      '01/01/2020',
    );
  });

  it('rellena con cero el día y el mes de un dígito', () => {
    expect(formatearFechaUtc(new Date('2026-03-05T00:00:00.000Z'))).toBe(
      '05/03/2026',
    );
  });
});

describe('normalizarFechaCalendario', () => {
  it('un ISO con hora se normaliza a medianoche UTC de la misma fecha calendario', () => {
    expect(
      normalizarFechaCalendario(new Date('2026-10-05T14:30:00.000Z')),
    ).toEqual(new Date('2026-10-05T00:00:00.000Z'));
  });

  it('una medianoche UTC queda igual', () => {
    expect(
      normalizarFechaCalendario(new Date('2026-10-05T00:00:00.000Z')),
    ).toEqual(new Date('2026-10-05T00:00:00.000Z'));
  });

  it('una hora que roza la medianoche no corre al día siguiente/anterior', () => {
    expect(
      normalizarFechaCalendario(new Date('2026-10-05T23:59:59.999Z')),
    ).toEqual(new Date('2026-10-05T00:00:00.000Z'));
  });
});

describe('describirVencimiento', () => {
  it('"<plan>: venció el <fecha>", sin adjetivo con género', () => {
    expect(
      describirVencimiento(
        'Licencia de conducir',
        new Date('2020-01-01T00:00:00.000Z'),
      ),
    ).toBe('Licencia de conducir: venció el 01/01/2020');
  });

  it('sin fecha registrada, lo dice así', () => {
    expect(describirVencimiento('VTV', null)).toBe('VTV: sin fecha registrada');
  });
});
