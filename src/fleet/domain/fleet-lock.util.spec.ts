import { MaintenanceCriticality } from '../entities/maintenance-plan.entity';
import { ExpirationStatus } from './expiration-status';
import { estaInhabilitado } from './fleet-lock.util';

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
