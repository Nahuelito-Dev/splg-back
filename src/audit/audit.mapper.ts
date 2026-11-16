import { AuditLog } from './entities/audit-log.entity';
import { AsientoDeAuditoriaDto } from './dto/audit-log-response.dto';

export class AuditMapper {
  static toDto(a: AuditLog): AsientoDeAuditoriaDto {
    const dto = new AsientoDeAuditoriaDto();
    dto.auditId = a.auditId;
    dto.distributorId = a.distributorId;
    dto.actorUserId = a.actorUserId;
    dto.actorRole = a.actorRole;
    dto.httpMethod = a.httpMethod;
    dto.resource = a.resource;
    dto.resourceId = a.resourceId;
    dto.path = a.path;
    dto.clientSource = a.clientSource;
    dto.ip = a.ip;
    dto.result = a.result;
    dto.statusCode = a.statusCode;
    dto.changes = a.changes;
    dto.errorMessage = a.errorMessage;
    dto.createdAt = a.createdAt;
    return dto;
  }
}
