import { User } from '../../users/entities/user.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import {
  SupportEndReason,
  SupportScope,
  SupportSessionKind,
  SupportSessionStatus,
} from '../domain/support-session.enums';
import { SupportAccess } from '../entities/support-access.entity';
import { SupportSession } from '../entities/support-session.entity';
import { SupportMapper } from './support.mapper';

describe('SupportMapper', () => {
  it('la sesión sale en camelCase, con las personas sin datos de contacto', () => {
    const s = Object.assign(new SupportSession(), {
      supportSessionId: 's1',
      distributorId: 'd1',
      distributor: Object.assign(new Distributor(), { name: 'Empresa A' }),
      requestedBy: 'u1',
      requester: Object.assign(new User(), {
        fullName: 'Soporte Uno',
        email: 'soporte@x.test',
      }),
      kind: SupportSessionKind.CONSENTED,
      status: SupportSessionStatus.REVOKED,
      reason: 'motivo',
      ticketRef: null,
      scope: [SupportScope.FILES],
      requestedMinutes: 60,
      requestExpiresAt: new Date('2026-11-14T12:00:00Z'),
      decidedBy: 'a1',
      decider: Object.assign(new User(), { fullName: 'Admin A' }),
      decidedAt: new Date('2026-11-13T12:00:00Z'),
      decisionNote: null,
      startedAt: new Date('2026-11-13T12:00:00Z'),
      expiresAt: new Date('2026-11-13T13:00:00Z'),
      endedAt: new Date('2026-11-13T12:10:00Z'),
      endedBy: 'a1',
      ender: null,
      endReason: SupportEndReason.REVOKED_BY_COMPANY,
      createdAt: new Date('2026-11-13T11:00:00Z'),
    });
    const dto = SupportMapper.toDto(s);
    expect(dto).toEqual({
      id: 's1',
      distributorId: 'd1',
      distributorName: 'Empresa A',
      requestedBy: { userId: 'u1', fullName: 'Soporte Uno' },
      kind: 'consented',
      status: 'revoked',
      reason: 'motivo',
      ticketRef: null,
      scope: ['files'],
      requestedMinutes: 60,
      requestExpiresAt: '2026-11-14T12:00:00.000Z',
      decidedBy: { userId: 'a1', fullName: 'Admin A' },
      decidedAt: '2026-11-13T12:00:00.000Z',
      decisionNote: null,
      startedAt: '2026-11-13T12:00:00.000Z',
      expiresAt: '2026-11-13T13:00:00.000Z',
      endedAt: '2026-11-13T12:10:00.000Z',
      endedBy: { userId: 'a1', fullName: null },
      endReason: 'revoked_by_company',
      createdAt: '2026-11-13T11:00:00.000Z',
    });
    expect(JSON.stringify(dto)).not.toContain('soporte@x.test');
  });

  it('un acceso sale sin la ip ni el usuario', () => {
    const a = Object.assign(new SupportAccess(), {
      supportAccessId: '7',
      supportSessionId: 's1',
      distributorId: 'd1',
      userId: 'u1',
      at: new Date('2026-11-13T12:01:00Z'),
      httpMethod: 'GET',
      path: '/api/v2/orders',
      resource: 'orders',
      resourceId: null,
      query: { status: 'pending' },
      statusCode: 200,
      items: 20,
      masked: true,
      ip: '10.0.0.1',
    });
    expect(SupportMapper.accesoToDto(a)).toEqual({
      id: '7',
      at: '2026-11-13T12:01:00.000Z',
      httpMethod: 'GET',
      path: '/api/v2/orders',
      resource: 'orders',
      resourceId: null,
      query: { status: 'pending' },
      statusCode: 200,
      items: 20,
      masked: true,
    });
  });
});
