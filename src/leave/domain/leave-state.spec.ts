import {
  LeaveStatus,
  cubreElDia,
  diasCorridos,
  sePisan,
  validarCancelacion,
  validarModificacion,
  validarPeriodo,
  validarRechazo,
  validarResolucion,
} from './leave-state';

describe('reglas de las licencias', () => {
  it('cuenta los días corridos con ambos extremos', () => {
    expect(diasCorridos('2026-03-01', '2026-03-01')).toBe(1);
    expect(diasCorridos('2026-02-27', '2026-03-02')).toBe(4);
  });

  it('el fin no puede ser anterior al inicio', () => {
    expect(validarPeriodo('2026-03-02', '2026-03-01')).toBe(
      'FIN_ANTERIOR_AL_INICIO',
    );
    expect(validarPeriodo('2026-03-01', '2026-03-01')).toBeNull();
  });

  it('dos períodos que se tocan en un día se pisan; los contiguos no', () => {
    const a = { startDate: '2026-03-01', endDate: '2026-03-10' };
    expect(sePisan(a, { startDate: '2026-03-10', endDate: '2026-03-12' })).toBe(
      true,
    );
    expect(sePisan(a, { startDate: '2026-03-11', endDate: '2026-03-12' })).toBe(
      false,
    );
    expect(sePisan(a, { startDate: '2026-02-01', endDate: '2026-03-01' })).toBe(
      true,
    );
  });

  it('cubre el día en los dos extremos', () => {
    const p = { startDate: '2026-03-01', endDate: '2026-03-10' };
    expect(cubreElDia(p, '2026-03-01')).toBe(true);
    expect(cubreElDia(p, '2026-03-10')).toBe(true);
    expect(cubreElDia(p, '2026-03-11')).toBe(false);
  });

  it('sólo una solicitada se modifica, se aprueba o se rechaza', () => {
    for (const estado of [
      LeaveStatus.APPROVED,
      LeaveStatus.REJECTED,
      LeaveStatus.CANCELLED,
    ]) {
      expect(validarModificacion(estado)).toBe('NO_ESTA_SOLICITADA');
      expect(validarResolucion(estado)).toBe('NO_ESTA_SOLICITADA');
    }
    expect(validarModificacion(LeaveStatus.REQUESTED)).toBeNull();
    expect(validarResolucion(LeaveStatus.REQUESTED)).toBeNull();
  });

  it('rechazar exige un motivo no vacío', () => {
    expect(validarRechazo(LeaveStatus.REQUESTED, '   ')).toBe(
      'MOTIVO_OBLIGATORIO',
    );
    expect(validarRechazo(LeaveStatus.REQUESTED, undefined)).toBe(
      'MOTIVO_OBLIGATORIO',
    );
    expect(validarRechazo(LeaveStatus.REQUESTED, 'Sin cobertura')).toBeNull();
    expect(validarRechazo(LeaveStatus.APPROVED, 'Sin cobertura')).toBe(
      'NO_ESTA_SOLICITADA',
    );
  });

  it('cancelar sirve para una solicitada o aprobada que no terminó', () => {
    const hoy = '2026-03-05';
    expect(
      validarCancelacion(
        { status: LeaveStatus.APPROVED, endDate: '2026-03-05' },
        hoy,
      ),
    ).toBeNull();
    expect(
      validarCancelacion(
        { status: LeaveStatus.REQUESTED, endDate: '2026-03-04' },
        hoy,
      ),
    ).toBe('YA_TERMINO');
    expect(
      validarCancelacion(
        { status: LeaveStatus.REJECTED, endDate: '2026-04-01' },
        hoy,
      ),
    ).toBe('YA_RESUELTA');
    expect(
      validarCancelacion(
        { status: LeaveStatus.CANCELLED, endDate: '2026-04-01' },
        hoy,
      ),
    ).toBe('YA_RESUELTA');
  });
});
