import {
  AdminNotificationLiveDto,
  AdminNotificationResponseDto,
} from './dto/admin-notification-response.dto';
import { AdminNotification } from './entities/admin-notification.entity';

export class AdminNotificationMapper {
  /** `readAt` es el del administrador que consulta, no un dato del aviso. */
  static toDto(
    aviso: AdminNotification,
    readAt: Date | null,
  ): AdminNotificationResponseDto {
    const dto = new AdminNotificationResponseDto();
    dto.id = aviso.notificationId;
    dto.kind = aviso.kind;
    dto.title = aviso.title;
    dto.body = aviso.body;
    dto.link =
      aviso.linkEntity && aviso.linkId
        ? { entity: aviso.linkEntity, id: aviso.linkId }
        : null;
    dto.createdAt = aviso.createdAt;
    dto.readAt = readAt;
    return dto;
  }

  /** El aviso recién creado, tal como llega al panel por el socket (sin leer). */
  static toLiveDto(aviso: AdminNotification): AdminNotificationLiveDto {
    const dto = new AdminNotificationLiveDto();
    Object.assign(dto, AdminNotificationMapper.toDto(aviso, null));
    dto.distributorId = aviso.distributorId;
    return dto;
  }
}
