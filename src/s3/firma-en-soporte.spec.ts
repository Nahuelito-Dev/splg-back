import { auditContext } from '../audit/data/audit-context';
import {
  FIRMA_MAXIMA_EN_SOPORTE_SEGUNDOS,
  segundosDeLaFirma,
} from './s3.service';

const AHORA = new Date('2026-11-13T12:00:00Z');
const ACTOR = { userId: 'u', ip: null, distributorId: 'd' };

function codigo(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    return (error as { response: { code: string } }).response.code;
  }
}

describe('URL firmadas en modo soporte (§4.7)', () => {
  it('fuera del modo soporte, el TTL configurado', () => {
    expect(segundosDeLaFirma(300, AHORA)).toBe(300);
    expect(auditContext.run(ACTOR, () => segundosDeLaFirma(300, AHORA))).toBe(
      300,
    );
  });

  it('sin el alcance files no se firma nada: 403 SUPPORT_SCOPE_REQUIRED', () => {
    const soporte = {
      ...ACTOR,
      soporte: {
        alcance: ['personal_data', 'exports'],
        vence: new Date('2026-11-13T13:00:00Z'),
      },
    };
    expect(
      auditContext.run(soporte, () =>
        codigo(() => segundosDeLaFirma(300, AHORA)),
      ),
    ).toBe('SUPPORT_SCOPE_REQUIRED');
  });

  it.each([
    [
      'falta mucho para el fin: el tope de 60 s',
      '2026-11-13T13:00:00Z',
      300,
      60,
    ],
    ['faltan 90 s: igual el tope de 60 s', '2026-11-13T12:01:30Z', 300, 60],
    [
      'faltan 45 s: dura 45 s (el fin de la sesión)',
      '2026-11-13T12:00:45Z',
      300,
      45,
    ],
    [
      'TTL configurado menor que el tope: el TTL',
      '2026-11-13T13:00:00Z',
      30,
      30,
    ],
  ])('con files, %s', (_n, vence, ttl, esperado) => {
    const soporte = {
      ...ACTOR,
      soporte: { alcance: ['files'], vence: new Date(vence) },
    };
    const segundos = auditContext.run(soporte, () =>
      segundosDeLaFirma(ttl, AHORA),
    );
    expect(segundos).toBe(esperado);
    expect(segundos).toBeLessThanOrEqual(FIRMA_MAXIMA_EN_SOPORTE_SEGUNDOS);
    expect(AHORA.getTime() + segundos * 1000).toBeLessThanOrEqual(
      new Date(vence).getTime(),
    );
  });

  it('con la sesión ya vencida: 403 SUPPORT_SESSION_ENDED', () => {
    const soporte = {
      ...ACTOR,
      soporte: {
        alcance: ['files'],
        vence: new Date('2026-11-13T12:00:00.500Z'),
      },
    };
    expect(
      auditContext.run(soporte, () =>
        codigo(() => segundosDeLaFirma(300, AHORA)),
      ),
    ).toBe('SUPPORT_SESSION_ENDED');
  });
});
