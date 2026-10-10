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
    // La foto subida a S3 (URL firmada) manda; sin ella, la URL externa de antes.
    dto.photo_url = i.photoSignedUrl ?? i.photoUrl;
    dto.status = i.status;
    dto.resolution_note = i.resolutionNote;
    dto.createdAt = i.createdAt;
    dto.resolvedAt = i.resolvedAt;
    if (i.order) dto.order = OrderRecordMapper.toDto(i.order);
    return dto;
  }
}
