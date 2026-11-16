import { Audit } from '../entities/audit.entity';
import { AuditDetail } from '../entities/audit-detail.entity';
import { AuditActionType } from '../entities/audit-action-type.entity';
import {
  AuditActionTypeDto,
  AuditDetailDto,
  AuditEntryDto,
  AuditEntryV2Dto,
  OrigenDeAuditoria,
} from './data-audit.dto';
import { APP_DE_LA_API } from './audit-origen';

export class DataAuditMapper {
  static actionTypeToDto(t: AuditActionType): AuditActionTypeDto {
    const dto = new AuditActionTypeDto();
    dto.id = t.actionTypeId;
    dto.name = t.name;
    return dto;
  }

  static detailToDto(d: AuditDetail): AuditDetailDto {
    const dto = new AuditDetailDto();
    dto.auditDetailId = d.auditDetailId;
    dto.field = d.field;
    dto.oldValue = d.oldValue;
    dto.newValue = d.newValue;
    return dto;
  }

  static toDto(a: Audit, details: AuditDetail[]): AuditEntryDto {
    const dto = new AuditEntryDto();
    dto.auditId = a.auditId;
    dto.actionType = a.actionType
      ? DataAuditMapper.actionTypeToDto(a.actionType)
      : { id: a.actionTypeId, name: '' };
    dto.userId = a.userId;
    dto.user = a.user
      ? {
          userId: a.user.userId,
          fullName: a.user.fullName ?? null,
          email: a.user.email ?? null,
          deleted: Boolean(a.user.deletedAt),
        }
      : null;
    dto.distributorId = a.distributorId;
    dto.entity = a.entity;
    dto.recordId = a.recordId;
    dto.ip = a.ip;
    dto.dateTime = a.createdAt;
    dto.details = details.map((d) => DataAuditMapper.detailToDto(d));
    return dto;
  }

  /**
   * `user` si tiene usuario. Sin usuario: `direct` si lo escribió el trigger
   * desde una aplicación que no es la API (SQL a mano, un script); el resto es
   * `system`, incluida la auditoría anterior a esta marca.
   */
  static origenDe(a: Audit): OrigenDeAuditoria {
    if (a.userId) return 'user';
    return a.source === 'db' && a.appName !== APP_DE_LA_API
      ? 'direct'
      : 'system';
  }

  static toDtoV2(a: Audit, details: AuditDetail[]): AuditEntryV2Dto {
    const dto = Object.assign(
      new AuditEntryV2Dto(),
      DataAuditMapper.toDto(a, details),
    );
    dto.origin = DataAuditMapper.origenDe(a);
    dto.source = a.source;
    dto.tableName = a.tableName;
    dto.dbUser = a.dbUser;
    dto.appName = a.appName;
    return dto;
  }
}
