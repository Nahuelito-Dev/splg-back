import { ApiProperty } from '@nestjs/swagger';
import {
  OrderDeliveryMode,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../../order/entities/order.entity';
import {
  DeliveryKind,
  FailedVisitOutcome,
  FailedVisitReason,
  RevisitResolution,
  RevisitStatus,
} from '../domain/nueva-visita';

/** Una franja con cupo en un día. */
export class RevisitSlotDto {
  @ApiProperty({ format: 'uuid' })
  timeSlotId!: string;

  @ApiProperty({ example: 'Mañana' })
  name!: string;

  @ApiProperty({ example: '09:00:00' })
  startTime!: string;

  @ApiProperty({ example: '13:00:00' })
  endTime!: string;

  @ApiProperty({ example: 12, description: 'Cupos libres' })
  remaining!: number;
}

/** Un día con sus franjas libres. */
export class RevisitDayDto {
  @ApiProperty({ type: String, format: 'date', example: '2026-11-26' })
  date!: string;

  @ApiProperty({ type: [RevisitSlotDto] })
  slots!: RevisitSlotDto[];

  @ApiProperty({
    example: true,
    description:
      'El chofer (o el admin) puede informar este día como acordado con el cliente (`agreed` de «No pude entregar»). `false` en el primer intento de una parada de hoja de ruta en curso: vuelve a pasar hoy al final del recorrido y el back rechaza el acuerdo con 409 `REVISIT_AGREEMENT_NOT_ALLOWED`. Es el mismo valor en todos los días de la respuesta.',
  })
  canAgree!: boolean;
}

/** La nueva visita del pedido tal como quedó. */
export class RevisitStateDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ enum: RevisitStatus, nullable: true })
  status!: RevisitStatus | null;

  @ApiProperty({ example: 1 })
  failedVisitCount!: number;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  scheduledDate!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  timeSlotId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Mañana' })
  timeSlotName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '09:00:00' })
  windowStart!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '13:00:00' })
  windowEnd!: string | null;

  @ApiProperty({
    description: 'El cliente todavía puede aceptar o elegir otro día',
  })
  canRespond!: boolean;
}

/** Respuesta de «No pude entregar». */
export class FailedDeliveryResponseDto extends RevisitStateDto {
  @ApiProperty({ format: 'uuid' })
  failedVisitId!: string;

  @ApiProperty({
    enum: FailedVisitOutcome,
    description:
      '`requeued`: hoja de ruta, vuelve a pasar hoy al final del recorrido; `proposed`: el sistema propuso día y franja; `agreed`: quedó lo acordado con el cliente; `awaiting_admin`: decide el admin',
  })
  outcome!: FailedVisitOutcome;

  @ApiProperty({ enum: DeliveryKind })
  deliveryKind!: DeliveryKind;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Hoja de ruta: la próxima parada que le toca al chofer',
  })
  nextOrderId!: string | null;
}

/** Una visita fallida en el historial del pedido. */
export class FailedVisitDto {
  @ApiProperty({ format: 'uuid' })
  failedVisitId!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ example: 1 })
  visitNumber!: number;

  @ApiProperty({ enum: DeliveryKind })
  deliveryKind!: DeliveryKind;

  @ApiProperty({ enum: FailedVisitReason })
  reason!: FailedVisitReason;

  @ApiProperty({ example: 'El cliente no estaba' })
  reasonLabel!: string;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  failedAt!: Date;

  @ApiProperty({ type: Number, nullable: true, example: -27.3671 })
  latitude!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: -55.8961 })
  longitude!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 12.5 })
  accuracyMeters!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 35,
    description: 'Metros al domicilio de entrega',
  })
  distanceMeters!: number | null;

  @ApiProperty({
    description: 'Informó más lejos del domicilio que el radio de llegada',
  })
  outOfRange!: boolean;

  @ApiProperty({ enum: ['delivery', 'admin', 'super_admin'] })
  reportedByRole!: 'delivery' | 'admin' | 'super_admin';

  @ApiProperty({ type: String, nullable: true, example: 'Juan Pérez' })
  reportedByName!: string | null;

  @ApiProperty({ enum: FailedVisitOutcome })
  outcome!: FailedVisitOutcome;

  @ApiProperty()
  agreedWithCustomer!: boolean;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  proposedDate!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  proposedTimeSlotId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Mañana' })
  proposedTimeSlotName!: string | null;

  @ApiProperty({ enum: RevisitResolution, nullable: true })
  resolution!: RevisitResolution | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  finalDate!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Tarde' })
  finalTimeSlotName!: string | null;
}

/** Un pedido con visitas fallidas, en el listado del panel. */
export class FailedVisitOrderDto {
  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ enum: OrderStatus, example: OrderStatus.PENDING })
  orderStatus!: OrderStatus;

  @ApiProperty({ enum: OrderDeliveryMode })
  deliveryMode!: OrderDeliveryMode;

  @ApiProperty({ enum: RevisitStatus, nullable: true })
  revisitStatus!: RevisitStatus | null;

  @ApiProperty({ example: 2 })
  failedVisitCount!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  lastFailedAt!: Date;

  @ApiProperty({ enum: FailedVisitReason })
  lastReason!: FailedVisitReason;

  @ApiProperty({ example: 'El cliente no estaba' })
  lastReasonLabel!: string;

  @ApiProperty({ type: String, nullable: true })
  lastNote!: string | null;

  @ApiProperty({ enum: DeliveryKind })
  lastDeliveryKind!: DeliveryKind;

  @ApiProperty({ type: Number, nullable: true })
  lastDistanceMeters!: number | null;

  @ApiProperty()
  lastOutOfRange!: boolean;

  @ApiProperty({ type: String, nullable: true })
  customerName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  customerPhone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  address!: string | null;

  @ApiProperty({ type: String, nullable: true })
  driverName!: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  scheduledDate!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  timeSlotId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  timeSlotName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  windowStart!: string | null;

  @ApiProperty({ type: String, nullable: true })
  windowEnd!: string | null;

  @ApiProperty({ example: 15000 })
  total!: number;

  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.CASH })
  paymentMethod!: PaymentMethod;

  @ApiProperty({ enum: PaymentStatus, example: PaymentStatus.PENDING })
  paymentStatus!: PaymentStatus;
}

export class FailedVisitOrdersPageDto {
  @ApiProperty({ type: [FailedVisitOrderDto] })
  data!: FailedVisitOrderDto[];

  @ApiProperty({ example: 3 })
  total!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;
}
