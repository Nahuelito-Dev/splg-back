import { estaAbierto } from '../domain/horario';
import type { MessageTemplate } from '../entities/message-template.entity';
import type { PlatformSupportSettings } from '../entities/platform-support-settings.entity';
import type {
  MessageTemplateResponseDto,
  SupportSettingsResponseDto,
} from './dto/support-settings.dto';

/** Respuestas de la configuración del soporte de la plataforma. */
export function plantillaADto(p: MessageTemplate): MessageTemplateResponseDto {
  return {
    id: p.templateId,
    scope: p.scope,
    key: p.key,
    title: p.title,
    body: p.body,
    active: p.active,
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function ajustesADto(
  a: PlatformSupportSettings,
): SupportSettingsResponseDto {
  return {
    timezone: a.timezone,
    chatHours: a.chatHours.map((f) => ({
      weekday: f.weekday,
      opensAt: f.opensAt,
      closesAt: f.closesAt,
    })),
    chatAckEnabled: a.chatAckEnabled,
    chatAckMessage: a.chatAckMessage,
    chatInactivityHours: a.chatInactivityHours,
    resolvedCloseDays: a.resolvedCloseDays,
    waitingCloseDays: a.waitingCloseDays,
    waitingWarnDays: a.waitingWarnDays,
    targetUrgentMinutes: a.targetUrgentMinutes,
    targetHighMinutes: a.targetHighMinutes,
    targetNormalMinutes: a.targetNormalMinutes,
    targetLowMinutes: a.targetLowMinutes,
    openNow: estaAbierto(a.chatHours, a.timezone, new Date()),
    updatedAt: a.updatedAt instanceof Date ? a.updatedAt.toISOString() : null,
  };
}
