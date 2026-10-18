import { ApiProperty } from '@nestjs/swagger';
import { RefundKind, RefundStatus } from '../domain/payment.enums';

/**
 * Una devolución vista por el cliente dueño del pedido. No expone la pasarela
 * (ids, intentos ni el texto del error): sólo lo que la app muestra.
 */
export class MyRefundResponseDto {
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
      '`pending`: en trámite; `succeeded`: acreditada; `failed`: la pasarela la rechazó y todavía no se acreditó; la distribuidora la está revisando',
  })
  status!: RefundStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt!: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo se acreditó; `null` si todavía no',
  })
  completedAt!: Date | null;
}
