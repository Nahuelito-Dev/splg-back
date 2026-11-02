import { ApiProperty } from '@nestjs/swagger';
import { ProposalStatus } from '../../common/enums/proposal-status.enum';
import {
  RouteBatchCloseReason,
  RouteBatchStatus,
} from '../../order/entities/route-batch.entity';

export class RouteBatchStopItemDto {
  @ApiProperty({ example: 'Garrafa 10 kg' }) name!: string;
  @ApiProperty({ example: 2 }) quantity!: number;
}

export class RouteBatchStopAddressDto {
  @ApiProperty({ example: 'Av. Corrientes 1234' }) street!: string;
  @ApiProperty({ example: 'Posadas' }) city!: string;
  @ApiProperty({ type: String, nullable: true }) floor!: string | null;
  @ApiProperty({ type: String, nullable: true }) apartment!: string | null;
  @ApiProperty({ type: String, nullable: true }) formattedAddress!:
    | string
    | null;
  @ApiProperty({ type: Number, nullable: true, example: -27.3671 })
  latitude!: number | null;
  @ApiProperty({ type: Number, nullable: true, example: -55.8961 })
  longitude!: number | null;
}

export class RouteBatchSlotDto {
  @ApiProperty({ example: 'Mañana' }) name!: string;
  @ApiProperty({ example: '08:00:00' }) startTime!: string;
  @ApiProperty({ example: '12:00:00' }) endTime!: string;
}

export class RouteBatchStopResponseDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ example: 1, description: 'Orden de entrega (1 = primera)' })
  sequence!: number;
  @ApiProperty({
    description:
      'Sigue en el lote. Es `false` si el pedido salió (se canceló o se asignó aparte) o el lote ya se cerró.',
  })
  active!: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Llegada estimada (velocidad media y tiempo de servicio fijos; si llega antes de la franja, espera a que abra)',
  })
  etaAt!: string | null;
  @ApiProperty({ description: 'Km desde la parada anterior (la primera: 0)' })
  legDistanceKm!: number;
  @ApiProperty({ example: 25 }) weightKg!: number;
  @ApiProperty({ example: '2026-11-03', description: 'Fecha agendada' })
  scheduledDate!: string;
  @ApiProperty({ type: RouteBatchSlotDto, nullable: true })
  slot!: RouteBatchSlotDto | null;
  @ApiProperty({ type: RouteBatchStopAddressDto })
  address!: RouteBatchStopAddressDto;
  @ApiProperty({ type: String, nullable: true }) customerName!: string | null;
  @ApiProperty({ example: 'cash' }) paymentMethod!: string;
  @ApiProperty({ example: 12000 }) totalAmount!: number;
  @ApiProperty({ example: 'pending', description: 'Estado actual del pedido' })
  orderStatus!: string;
  @ApiProperty({ type: [RouteBatchStopItemDto] })
  items!: RouteBatchStopItemDto[];
}

export class RouteBatchOfferResponseDto {
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) deliveryId!: string;
  @ApiProperty({ type: String, nullable: true }) driverName!: string | null;
  @ApiProperty({ enum: ProposalStatus }) status!: ProposalStatus;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  respondedAt!: string | null;
}

export class RouteBatchDriverDto {
  @ApiProperty({ format: 'uuid' }) deliveryId!: string;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
}

export class RouteBatchResponseDto {
  @ApiProperty({ format: 'uuid' }) batchId!: string;
  @ApiProperty({ enum: RouteBatchStatus }) status!: RouteBatchStatus;
  @ApiProperty({ example: 75.5 }) totalWeightKg!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt!: string | null;
  @ApiProperty({ enum: RouteBatchCloseReason, nullable: true })
  closeReason!: RouteBatchCloseReason | null;
  @ApiProperty({
    type: RouteBatchDriverDto,
    nullable: true,
    description: 'El chofer que aceptó el lote',
  })
  driver!: RouteBatchDriverDto | null;
  @ApiProperty({
    type: RouteBatchOfferResponseDto,
    nullable: true,
    description: 'La oferta vigente (pendiente), si hay',
  })
  currentOffer!: RouteBatchOfferResponseDto | null;
  @ApiProperty({
    type: [RouteBatchOfferResponseDto],
    description: 'Todos los choferes contactados, del primero al último',
  })
  offers!: RouteBatchOfferResponseDto[];
  @ApiProperty({
    type: [RouteBatchStopResponseDto],
    description: 'Paradas en orden de entrega',
  })
  stops!: RouteBatchStopResponseDto[];
}

export class RouteBatchPageDto {
  @ApiProperty({ type: [RouteBatchResponseDto] })
  data!: RouteBatchResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description:
      'Cantidad de lotes por estado (forming, offered, assigned, dissolved, completed), sin filtros',
    example: { offered: 1, assigned: 2 },
  })
  counts!: Record<string, number>;
}

export class RouteBatchRunReasonsDto {
  @ApiProperty({
    description:
      'Pedidos sin lote porque no había ningún chofer de la distribuidora en el radar',
  })
  noDriversNearby!: number;
  @ApiProperty({
    description:
      'Pedidos sin lote porque los choferes del radar no pueden recibirlo (flota o taller, laboral, carga del camión, pedido en curso, lote ya ofrecido) o no se pudo diagnosticar',
  })
  driversNotEligible!: number;
  @ApiProperty({
    description:
      'Pedidos sin lote porque había chofer pero el grupo quedó con menos de 2 paradas (radio, franja o capacidad del vehículo) o el pedido quedó solo',
  })
  notEnoughStops!: number;
  @ApiProperty({
    description:
      'Pedidos sin lote porque otro proceso (despacho individual) los tomó o cambiaron mientras se armaba',
  })
  lockConflict!: number;
}

export class RouteBatchRunDriverDetailDto {
  @ApiProperty({ example: 'Ramón Gómez' }) driverName!: string;
  @ApiProperty({
    type: [String],
    example: ['su vehículo tiene el taller programado en este horario'],
  })
  reasons!: string[];
}

export class RouteBatchRunResponseDto {
  @ApiProperty({ description: 'Pedidos programados que podían agruparse' })
  candidates!: number;
  @ApiProperty({ description: 'Lotes armados y ofrecidos en esta corrida' })
  batches!: number;
  @ApiProperty({ description: 'Pedidos que quedaron en esos lotes' })
  orders!: number;
  @ApiProperty({
    type: RouteBatchRunReasonsDto,
    description:
      'Por qué quedaron pedidos sin lote: cada pedido sin lote se cuenta una vez, en un solo motivo, y la suma de los cuatro es `candidates - orders` (también con un único candidato). Se completa sólo en «armar ahora»; en el cron queda en cero.',
  })
  reasons!: RouteBatchRunReasonsDto;
  @ApiProperty({
    type: [RouteBatchRunDriverDetailDto],
    description:
      'Hasta 5 choferes de la distribuidora que estaban en el radar y no podían recibir un lote, con los motivos en castellano. Vacío si ningún pedido quedó sin lote por culpa de los choferes.',
  })
  driversNotEligibleDetail!: RouteBatchRunDriverDetailDto[];
}

/** Lo que ve el chofer: la oferta con las paradas, sin la historia de los otros choferes. */
export class DriverRouteBatchOfferDto {
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ enum: ProposalStatus }) status!: ProposalStatus;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  respondedAt!: string | null;
}

export class DriverRouteBatchResponseDto {
  @ApiProperty({ format: 'uuid' }) batchId!: string;
  @ApiProperty({ enum: RouteBatchStatus }) status!: RouteBatchStatus;
  @ApiProperty({ example: 75.5 }) totalWeightKg!: number;
  @ApiProperty({ example: 3 }) stopCount!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({
    type: DriverRouteBatchOfferDto,
    nullable: true,
    description: 'Mi oferta de este lote (la última)',
  })
  offer!: DriverRouteBatchOfferDto | null;
  @ApiProperty({
    type: [RouteBatchStopResponseDto],
    description: 'Paradas en orden de entrega',
  })
  stops!: RouteBatchStopResponseDto[];
}

export class DriverRouteBatchPageDto {
  @ApiProperty({ type: [DriverRouteBatchResponseDto] })
  data!: DriverRouteBatchResponseDto[];
  @ApiProperty() total!: number;
}

export class DriverRouteBatchDecisionDto {
  @ApiProperty({ format: 'uuid' }) batchId!: string;
  @ApiProperty({ example: true }) accepted!: boolean;
  @ApiProperty({
    description:
      'Pedidos que quedaron asignados al chofer (al aceptar). Un pedido que se canceló o se asignó aparte mientras tanto no cuenta.',
  })
  assignedOrders!: number;
}
