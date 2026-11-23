import type { User } from '../../users/entities/user.entity';
import type { SupportAccess } from '../entities/support-access.entity';
import type { SupportSession } from '../entities/support-session.entity';
import {
  SupportAccessEntryDto,
  SupportActorDto,
  SupportSessionResponseDto,
} from './dto/support-session-response.dto';

const fecha = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** La foto firmada de cada persona, por `userId` (la junta `SupportSessionPresenter`). */
export type FotosDeLasPersonas = ReadonlyMap<string, string | null>;

function actor(
  id: string | null,
  usuario: User | null | undefined,
  fotos: FotosDeLasPersonas | undefined,
): SupportActorDto | null {
  if (!id) return null;
  return {
    userId: id,
    fullName: usuario?.fullName ?? null,
    photoUrl: fotos?.get(id) ?? null,
  };
}

export class SupportMapper {
  /**
   * La sesión con `distributor`, `requester`, `decider` y `ender` cargados.
   * Sin `fotos`, `photoUrl` sale `null` (el mapper no conoce S3).
   */
  static toDto(
    s: SupportSession,
    fotos?: FotosDeLasPersonas,
  ): SupportSessionResponseDto {
    return {
      id: s.supportSessionId,
      distributorId: s.distributorId,
      distributorName: s.distributor?.name ?? '',
      requestedBy: {
        userId: s.requestedBy,
        fullName: s.requester?.fullName ?? null,
        photoUrl: fotos?.get(s.requestedBy) ?? null,
      },
      kind: s.kind,
      status: s.status,
      reason: s.reason,
      ticketRef: s.ticketRef,
      scope: s.scope,
      requestedMinutes: s.requestedMinutes,
      requestExpiresAt: fecha(s.requestExpiresAt),
      decidedBy: actor(s.decidedBy, s.decider, fotos),
      decidedAt: fecha(s.decidedAt),
      decisionNote: s.decisionNote,
      startedAt: fecha(s.startedAt),
      expiresAt: fecha(s.expiresAt),
      endedAt: fecha(s.endedAt),
      endedBy: actor(s.endedBy, s.ender, fotos),
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
