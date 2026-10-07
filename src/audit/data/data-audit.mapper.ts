import { Audit } from '../entities/audit.entity';
import { AuditDetail } from '../entities/audit-detail.entity';
import { AuditActionType } from '../entities/audit-action-type.entity';
import {
  AuditActionTypeDto,
  AuditDetailDto,
  AuditEntryDto,
} from './data-audit.dto';

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
}
