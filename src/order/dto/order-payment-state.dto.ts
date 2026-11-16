import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  LedgerPaymentStatus,
  OrigenDelEstadoDelPago,
} from '../../payments/domain/payment.enums';

/** Una entrada del historial de estados de un pago (sólo staff). */
export class PaymentStatusChangeDto {
  @ApiProperty({
    enum: LedgerPaymentStatus,
    enumName: 'LedgerPaymentStatus',
    description: 'Estado que informó Mercado Pago',
  })
  status!: LedgerPaymentStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'cc_rejected_insufficient_amount',
    description: 'Motivo (`status_detail`) que informó Mercado Pago',
  })
  statusDetail!: string | null;

  @ApiProperty({
    example: 'Fondos insuficientes en el medio de pago',
    description: 'El texto en castellano de ese estado y motivo',
  })
  label!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  at!: string;

  @ApiProperty({
    enum: OrigenDelEstadoDelPago,
    enumName: 'OrigenDelEstadoDelPago',
    description:
      'De dónde salió la lectura: el aviso de la pasarela, la conciliación o una consulta',
  })
  origin!: OrigenDelEstadoDelPago;

  @ApiProperty({
    description:
      '`false`: el aviso llegó fuera de orden (p. ej. «aprobado» después de «devuelto») y no cambió el estado del pago',
  })
  applied!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Id del pago en Mercado Pago',
  })
  gatewayPaymentId!: string | null;
}

/** El estado del pago de un pedido de Mercado Pago, tal como lo muestran la app y el panel. */
export class OrderPaymentStateDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({
    enum: LedgerPaymentStatus,
    enumName: 'LedgerPaymentStatus',
    nullable: true,
    description:
      'Uno de los nueve estados de pago de Mercado Pago. Si el pedido tiene varios intentos, el que lo representa: el acreditado (o con reclamo), si no el contracargo o la devolución, el que está en curso, el pendiente y recién al final un rechazo o cancelación. `null`: el pedido no tiene pagos de Mercado Pago (efectivo, transferencia o todavía sin checkout).',
  })
  paymentStatus!: LedgerPaymentStatus | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'cc_rejected_insufficient_amount',
    description:
      'Motivo del estado que informa Mercado Pago (`status_detail`), tal cual',
  })
  paymentStatusDetail!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Rechazado por el banco',
    description:
      'El texto en castellano del estado y su motivo, armado por el back: las apps y el panel lo muestran sin reinterpretarlo. Un rechazo sin motivo conocido dice «Rechazado por el banco».',
  })
  paymentStatusLabel!: string | null;

  @ApiProperty({
    description:
      '`true`: el pedido sigue vivo y sin pagar, el pago no está en curso y el enlace de Mercado Pago no venció: el comprador puede reintentar con otro medio sobre `paymentUrl`',
  })
  canRetry!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Enlace de Checkout Pro para reintentar; `null` si `canRetry` es `false`',
  })
  paymentUrl!: string | null;

  @ApiProperty({
    description:
      '`true`: Mercado Pago avisó una alerta de fraude sobre el pago y el pedido está retenido (no se despacha ni se activa). Un administrador lo libera con `PATCH /v2/orders/:id/payment/fraud-hold/release` o lo cancela.',
  })
  paymentFraudHold!: boolean;

  @ApiPropertyOptional({
    type: PaymentStatusChangeDto,
    isArray: true,
    description:
      'Historial de cambios de estado, del más viejo al más nuevo. Sólo lo ven admin y super admin.',
  })
  history?: PaymentStatusChangeDto[];
}
