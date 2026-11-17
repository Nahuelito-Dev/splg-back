import type { AgenteDeLaBandeja } from '../application/equipo-de-la-bandeja.service';
import type {
  ChatAgentDto,
  ChatStatusResponseDto,
} from './dto/bandeja-response.dto';

/** El estado propio en la bandeja (8b). */
export function estadoADto(a: AgenteDeLaBandeja): ChatStatusResponseDto {
  return {
    status: a.status,
    connected: a.connected,
    available: a.available,
    maxOpen: a.maxOpen,
    maxOpenOverride: a.maxOpenOverride,
    openAssigned: a.openAssigned,
    channels: [...a.channels],
  };
}

/** Una persona en el tablero del equipo: sin email ni teléfono. */
export function agenteADto(a: AgenteDeLaBandeja): ChatAgentDto {
  return {
    userId: a.userId,
    name: a.name,
    ...estadoADto(a),
    lastAssignedAt: a.lastAssignedAt?.toISOString() ?? null,
  };
}
