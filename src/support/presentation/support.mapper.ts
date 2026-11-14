import type { User } from '../../users/entities/user.entity';
import type { SupportAccess } from '../entities/support-access.entity';
import type { SupportSession } from '../entities/support-session.entity';
import {
  SupportAccessEntryDto,
  SupportActorDto,
  SupportSessionResponseDto,
} from './dto/support-session-response.dto';

const fecha = (d: Date | null): string | null => (d ? d.toISOString() : null);

function actor(
  id: string | null,
  usuario: User | null | undefined,
): SupportActorDto | null {
  if (!id) return null;
  return { userId: id, fullName: usuario?.fullName ?? null };
}

export class SupportMapper {
  /** La sesión con `distributor`, `requester`, `decider` y `ender` cargados. */
  static toDto(s: SupportSession): SupportSessionResponseDto {
    return {
      id: s.supportSessionId,
      distributorId: s.distributorId,
      distributorName: s.distributor?.name ?? '',
      requestedBy: {
        userId: s.requestedBy,
        fullName: s.requester?.fullName ?? null,
      },
      kind: s.kind,
      status: s.status,
      reason: s.reason,
      ticketRef: s.ticketRef,
      scope: s.scope,
      requestedMinutes: s.requestedMinutes,
      requestExpiresAt: fecha(s.requestExpiresAt),
      decidedBy: actor(s.decidedBy, s.decider),
      decidedAt: fecha(s.decidedAt),
      decisionNote: s.decisionNote,
      startedAt: fecha(s.startedAt),
      expiresAt: fecha(s.expiresAt),
      endedAt: fecha(s.endedAt),
      endedBy: actor(s.endedBy, s.ender),
      endReason: s.endReason,
      createdAt: s.createdAt.toISOString(),
    };
  }

  static accesoToDto(a: SupportAccess): SupportAccessEntryDto {
    return {
      id: a.supportAccessId,
      at: a.at.toISOString(),
      httpMethod: a.httpMethod,
      path: a.path,
      resource: a.resource,
      resourceId: a.resourceId,
      query: a.query,
      statusCode: a.statusCode,
      items: a.items,
      masked: a.masked,
    };
  }
}
