import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IncidentStatus, IncidentType } from '../entities/incident.entity';
import { OrderRecordResponseDto } from '../../order/dto/order-record-response.dto';

export class IncidentResponseDto {
  @ApiProperty({ format: 'uuid' }) incident_id!: string;
  @ApiProperty({ format: 'uuid' }) order_id!: string;
  @ApiProperty({ format: 'uuid' }) distributor_id!: string;
  @ApiProperty({ format: 'uuid', description: 'Usuario que la reportó' })
  reported_by!: string;
  @ApiProperty({ enum: IncidentType }) type!: IncidentType;
  @ApiProperty() description!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Foto: URL firmada de S3 si se subió una (vence), si no la URL externa que traía.',
  })
  photo_url!: string | null;
  @ApiProperty({ enum: IncidentStatus }) status!: IncidentStatus;
  @ApiProperty({ type: String, nullable: true })
  resolution_note!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt!: Date | null;
  @ApiPropertyOptional({ type: OrderRecordResponseDto })
  order?: OrderRecordResponseDto;
}
