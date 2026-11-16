import { ApiProperty } from '@nestjs/swagger';
import { PaymentStatus } from '../../order/entities/order.entity';
import { IncidentResponseDto } from './incident-response.dto';

/** Respuesta de `PATCH /orders/:id/payment/unpaid`. */
export class UnpaidCashResponseDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ enum: PaymentStatus, example: PaymentStatus.UNPAID })
  paymentStatus!: PaymentStatus;

  @ApiProperty({
    type: IncidentResponseDto,
    description:
      'Incidencia de tipo `unpaid_collection` abierta por el impago (la misma si se repite la llamada)',
  })
  incident!: IncidentResponseDto;
}
