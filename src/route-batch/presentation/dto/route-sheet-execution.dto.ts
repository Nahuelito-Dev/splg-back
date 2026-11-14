import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { RouteStopRemovedReason } from '../../../order/entities/route-batch-stop.entity';
import { FailedDeliveryReason } from '../../application/route-sheet-stops.service';
import { RouteBatchStatus } from '../../domain/route-batch.enums';
import type { StopProgress } from '../../domain/route-sheet-execution';

const recortar = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// ───────────────────────── entrada ─────────────────────────

export class StartRouteSheetDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'El chofer sabe que al camión le faltan garrafas para la hoja y sale igual (D-04). Sin esto, un faltante responde 409 `ROUTE_SHEET_SHORTAGES` con `shortages[]`',
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeShortages?: boolean;
}

export class FailedStopDto {
  @ApiProperty({
    enum: FailedDeliveryReason,
    description:
      'customer_absent (no estaba), rejected (rechazó el pedido), wrong_address (la dirección no es correcta), no_access (no se pudo llegar), other (otro: `note` obligatoria)',
  })
  @IsEnum(FailedDeliveryReason)
  reason!: FailedDeliveryReason;

  @ApiPropertyOptional({
    maxLength: 280,
    description:
      'Detalle; obligatorio (3 a 280 caracteres) con `reason: other`',
  })
  @Transform(recortar)
  @ValidateIf(
    (o: FailedStopDto) => o.reason === FailedDeliveryReason.OTHER || !!o.note,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(280)
  note?: string;
}

export class CloseRouteSheetDto {
  @ApiProperty({
    minLength: 5,
    maxLength: 280,
    description:
      'Por qué se cierra la hoja a mano (las paradas pendientes salen y sus pedidos vuelven al despacho)',
  })
  @Transform(recortar)
  @IsString()
  @MinLength(5)
  @MaxLength(280)
  reason!: string;
}

// ───────────────────────── salida ─────────────────────────

export class StartRouteSheetShortageDto {
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ type: String, nullable: true }) type!: string | null;
  @ApiProperty({ description: 'Llenas que pide la hoja' }) required!: number;
  @ApiProperty({ description: 'Llenas en el camión' }) onTruck!: number;
  @ApiProperty() missing!: number;
}

export class StartRouteSheetResponseDto {
  @ApiProperty({ format: 'uuid' }) sheetId!: string;
  @ApiProperty({
    description:
      'La hoja ya estaba iniciada por este chofer (reintento): no se hizo nada',
  })
  alreadyStarted!: boolean;
  @ApiProperty({ type: [String], description: 'Pedidos asignados al chofer' })
  assignedOrderIds!: string[];
  @ApiProperty({
    type: [String],
    description:
      'Pedidos que ya no estaban disponibles (cancelados, de otro chofer, Mercado Pago sin pagar): salieron de la hoja y vuelven al despacho',
  })
  droppedOrderIds!: string[];
  @ApiProperty({
    type: [StartRouteSheetShortageDto],
    description: 'Faltantes aceptados con `acknowledgeShortages`',
  })
  shortages!: StartRouteSheetShortageDto[];
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  truckLoadId!: string | null;
  @ApiProperty({
    description:
      'Clientes a los que se les avisó por push que su pedido está en camino, con la franja estimada (0 en un reintento)',
  })
  notifiedCustomers!: number;
}

export class RouteSheetStopActionResponseDto {
  @ApiProperty({ format: 'uuid' }) sheetId!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'La parada que la app le propone al chofer ahora',
  })
  nextOrderId!: string | null;
  @ApiPropertyOptional({
    description:
      'Era otra la siguiente: la cola se reordenó desde esta parada (desvío)',
  })
  detour?: boolean;
  @ApiPropertyOptional({
    enum: [1, 2],
    description: '«No pude entregar»: qué intento fue',
  })
  attempt?: 1 | 2;
  @ApiPropertyOptional({
    enum: ['requeued', 'rescheduled'],
    description:
      '«No pude entregar»: `requeued` (primer intento: la parada pasó al final de la cola del chofer y la ruta se recalculó) o `rescheduled` (segundo: salió de la hoja y el pedido se reprogramó solo para el primer día hábil con la planificación abierta, sin franja fija; no vuelve al despacho común)',
  })
  outcome?: 'requeued' | 'rescheduled';
  @ApiPropertyOptional({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-11-16',
    description:
      'Segundo intento: la fecha nueva del pedido (el primer día hábil con la planificación abierta, sin franja fija); `null` si no se pudo reprogramar solo (se canceló o se asignó en el medio) y espera al admin',
  })
  rescheduledTo?: string | null;
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Primer intento: inicio de la franja estimada nueva del pedido («se reprogramó para más tarde»), con la ruta recalculada desde la posición actual; `null` si no tiene hora estimada',
  })
  newWindowStart?: string | null;
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Primer intento: fin de la franja estimada nueva',
  })
  newWindowEnd?: string | null;
}

export class RouteSheetArrivedResponseDto {
  @ApiProperty() message!: string;
  @ApiProperty({ format: 'date-time' }) arrivedAt!: string;
}

export class RescheduledOrderDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  scheduledDate!: string | null;
}

export class CloseRouteSheetResponseDto {
  @ApiProperty({ format: 'uuid' }) sheetId!: string;
  @ApiProperty({ description: 'Ya estaba cerrada: no se hizo nada' })
  alreadyClosed!: boolean;
  @ApiProperty({
    type: [String],
    description:
      'Paradas pendientes que salieron de la hoja (se reprogramaron solas para el día hábil siguiente)',
  })
  releasedOrderIds!: string[];
  @ApiProperty({
    type: [RescheduledOrderDto],
    description:
      'La fecha nueva de cada pedido pendiente (`scheduledDate: null`: no se pudo reprogramar y espera al admin)',
  })
  rescheduled!: RescheduledOrderDto[];
}

export class RouteSheetItemDto {
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ type: String, nullable: true }) type!: string | null;
  @ApiProperty() quantity!: number;
}

const PROGRESOS: StopProgress[] = [
  'pending',
  'on_the_way',
  'delivered',
  'failed',
  'removed',
];

export class RouteSheetExecutionStopDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Orden en la hoja; `null` si la parada salió',
  })
  sequence!: number | null;
  @ApiProperty({
    enum: PROGRESOS,
    description:
      'pending (falta; un reintento también, con `failedAttempts: 1`), on_the_way (el chofer va para allá), delivered, failed (no se entregó en el segundo intento: se reprogramó solo, `removedReason: rescheduled`), removed (salió de la hoja: cancelado, de otro chofer, el admin la sacó o quedó pendiente al cerrar a mano —se reprograma sola—)',
  })
  progress!: StopProgress;
  @ApiProperty({
    enum: RouteStopRemovedReason,
    nullable: true,
    description: 'Por qué salió de la hoja',
  })
  removedReason!: RouteStopRemovedReason | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Motivo contado por el chofer o quien cerró la hoja',
  })
  removedNote!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  removedAt!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo avisó «Llegué» (se borra si la parada vuelve a la cola)',
  })
  arrivedAt!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Hasta cuándo espera el chofer en la puerta (`arrivedAt` + `arrivalWaitMinutes`); vencida, se le sugiere «No pude entregar»',
  })
  waitExpiresAt!: string | null;
  @ApiProperty({
    description:
      'Intentos de entrega fallidos (0, 1: está al final de la cola, 2: salió de la hoja)',
  })
  failedAttempts!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastFailedAt!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Lo que contó el chofer en el último intento fallido',
  })
  lastFailureNote!: string | null;
  @ApiProperty({
    description:
      'Salió de la hoja en la calle y el pedido sigue pendiente para ESE día sin chofer: el admin la sacó, se liberó por fuera de la hoja o no se pudo reprogramar solo. Espera que el admin lo reprograme, lo asigne o lo cancele (el despacho común no lo toma)',
  })
  awaitingAdmin!: boolean;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description:
      'Si el pedido salió de la hoja y ahora está programado para otro día (la reprogramación automática o el admin): esa fecha',
  })
  rescheduledTo!: string | null;
  @ApiProperty({ type: String, nullable: true }) customerName!: string | null;
  @ApiProperty({ type: String, nullable: true }) customerPhone!: string | null;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
  @ApiProperty({ type: Number, nullable: true }) lat!: number | null;
  @ApiProperty({ type: Number, nullable: true }) lng!: number | null;
  @ApiProperty({ type: String, nullable: true }) slotName!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  slotStart!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  slotEnd!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Llegada estimada vigente (recalculada en la calle)',
  })
  etaAt!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Llegada prometida al confirmar',
  })
  plannedEtaAt!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Franja que se le avisó al cliente (desde)',
  })
  notifiedWindowStart!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  notifiedWindowEnd!: string | null;
  @ApiProperty({
    description: 'Pendiente o en camino y va a llegar después de su franja',
  })
  late!: boolean;
  @ApiProperty() units!: number;
  @ApiProperty() weightKg!: number;
  @ApiProperty() unpaidOnline!: boolean;
  @ApiProperty({ type: [RouteSheetItemDto] }) items!: RouteSheetItemDto[];
}

export class RouteSheetProgressDto {
  @ApiProperty() total!: number;
  @ApiProperty() delivered!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() removed!: number;
  @ApiProperty({ description: 'Pendientes más la que está en camino' })
  pending!: number;
}

export class DriverLocationDto {
  @ApiProperty() lat!: number;
  @ApiProperty() lng!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  at!: string | null;
}

export class RouteSheetExecutionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: Number, nullable: true }) number!: number | null;
  @ApiProperty({ format: 'date', example: '2026-11-15' }) planDate!: string;
  @ApiProperty({ enum: RouteBatchStatus }) status!: RouteBatchStatus;
  @ApiProperty() version!: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  deliveryId!: string | null;
  @ApiProperty({ type: String, nullable: true }) driverName!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  carId!: string | null;
  @ApiProperty({ type: String, nullable: true }) carPatent!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  truckLoadId!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  plannedStartAt!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo los pedidos quedaron asignados al chofer (antes de eso, la hoja confirmada los retiene para él)',
  })
  assignedAt!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo se inició el viaje',
  })
  startedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Motivo del cierre a mano',
  })
  closeNote!: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'La parada en camino',
  })
  currentOrderId!: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'La que la app le propone al chofer (la en camino o la primera pendiente); sólo en curso',
  })
  nextOrderId!: string | null;
  @ApiProperty({ type: RouteSheetProgressDto })
  progress!: RouteSheetProgressDto;
  @ApiProperty({
    type: DriverLocationDto,
    nullable: true,
    description:
      'Última posición del chofer (sólo en el seguimiento del panel)',
  })
  driverLocation!: DriverLocationDto | null;
  @ApiProperty({
    type: [RouteSheetExecutionStopDto],
    description:
      'Primero las activas en su orden; después las que salieron en la calle',
  })
  stops!: RouteSheetExecutionStopDto[];
}

export class OrderEtaDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'date-time' }) etaAt!: string;
  @ApiProperty({
    format: 'date-time',
    description: 'Llega entre… (desde)',
  })
  windowStart!: string;
  @ApiProperty({ format: 'date-time', description: '…y (hasta)' })
  windowEnd!: string;
  @ApiProperty({ enum: ['route_sheet'] }) source!: 'route_sheet';
  @ApiProperty({
    description:
      'El chofer ya salió con la hoja (la hora se recalcula en vivo)',
  })
  inProgress!: boolean;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
