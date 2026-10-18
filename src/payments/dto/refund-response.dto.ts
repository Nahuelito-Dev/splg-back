import { ApiProperty } from '@nestjs/swagger';
import { RefundKind, RefundStatus } from '../domain/payment.enums';

/** Una solicitud de devolución a la pasarela (CU-168). */
export class RefundResponseDto {
  @ApiProperty({ format: 'uuid' })
  refundId!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Pago del ledger que se devuelve',
  })
  paymentId!: string;

  @ApiProperty({
    enum: RefundKind,
    description:
      '`full`: lo que faltaba devolver del pago (el pedido se canceló); `express_surcharge`: sólo el recargo express',
  })
  kind!: RefundKind;

  @ApiProperty({ example: 1500 })
  amount!: number;

  @ApiProperty({
    enum: RefundStatus,
    description:
      '`failed` se puede reintentar con `POST /orders/:id/refunds/retry`',
  })
  status!: RefundStatus;

  @ApiProperty({ type: String, nullable: true })
  gatewayRefundId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Por qué falló el último intento',
  })
  errorMessage!: string | null;

  @ApiProperty({ example: 1, description: 'Intentos contra la pasarela' })
  attempts!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  refundedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

export class RefundListResponseDto {
  @ApiProperty({ type: [RefundResponseDto] })
  items!: RefundResponseDto[];

  @ApiProperty({ example: 3 })
  total!: number;

  @ApiProperty({ example: 10 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;
}
