import { Incident } from './entities/incident.entity';
import { IncidentResponseDto } from './dto/incident-response.dto';
import { OrderRecordMapper } from '../order/order-record.mapper';

export class IncidentMapper {
  static toDto(i: Incident): IncidentResponseDto {
    const dto = new IncidentResponseDto();
    dto.incident_id = i.incident_id;
    dto.order_id = i.order_id;
    dto.distributor_id = i.distributor_id;
    dto.reported_by = i.reported_by;
    dto.type = i.type;
    dto.description = i.description;
    dto.photo_url = i.photo_url;
    dto.status = i.status;
    dto.resolution_note = i.resolution_note;
    dto.createdAt = i.createdAt;
    dto.resolvedAt = i.resolvedAt;
    if (i.order) dto.order = OrderRecordMapper.toDto(i.order);
    return dto;
  }
}
