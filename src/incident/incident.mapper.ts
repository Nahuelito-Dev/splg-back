import { Incident } from './entities/incident.entity';
import { IncidentResponseDto } from './dto/incident-response.dto';
import { OrderRecordMapper } from '../order/order-record.mapper';

export class IncidentMapper {
  static toDto(i: Incident): IncidentResponseDto {
    const dto = new IncidentResponseDto();
    dto.incident_id = i.incidentId;
    dto.order_id = i.orderId;
    dto.distributor_id = i.distributorId;
    dto.reported_by = i.reportedBy;
    dto.type = i.type;
    dto.description = i.description;
    // Sólo la foto de S3, firmada: la columna `photo_url` es legada y no se expone.
    dto.photo_url = i.photoSignedUrl ?? null;
    dto.status = i.status;
    dto.resolution_note = i.resolutionNote;
    dto.createdAt = i.createdAt;
    dto.resolvedAt = i.resolvedAt;
    if (i.order) dto.order = OrderRecordMapper.toDto(i.order);
    return dto;
  }
}
