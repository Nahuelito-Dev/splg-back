import type { AdminGateway } from '../../gateways/admin.gateway';
import {
  SupportEndReason,
  SupportSessionStatus,
} from '../domain/support-session.enums';
import { SupportEndedNotice } from './support-ended.notice';

describe('SupportEndedNotice', () => {
  const sesion = {
    supportSessionId: 'sesion-1',
    requestedBy: 'super-1',
    status: SupportSessionStatus.REVOKED,
    endReason: SupportEndReason.REVOKED_BY_COMPANY,
  };

  it('avisa por la sala personal de quien pidió la sesión', () => {
    const gateway = { avisarFinDeSoporte: jest.fn() };
    new SupportEndedNotice(gateway as unknown as AdminGateway).avisar(sesion);
    expect(gateway.avisarFinDeSoporte).toHaveBeenCalledWith('super-1', {
      sessionId: 'sesion-1',
      status: SupportSessionStatus.REVOKED,
      endReason: SupportEndReason.REVOKED_BY_COMPANY,
    });
  });

  it('si el socket falla no corta la operación: sólo lo anota', () => {
    const gateway = {
      avisarFinDeSoporte: jest.fn(() => {
        throw new Error('socket caído');
      }),
    };
    const aviso = new SupportEndedNotice(gateway as unknown as AdminGateway);
    const anotar = jest
      .spyOn(
        (aviso as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    expect(() => aviso.avisar(sesion)).not.toThrow();
    expect(anotar).toHaveBeenCalledWith(
      expect.stringContaining('sesion-1: socket caído'),
    );
  });
});
