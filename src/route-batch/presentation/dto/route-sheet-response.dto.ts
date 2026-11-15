import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RouteBatchStatus } from '../../domain/route-batch.enums';
import { RoutePlanStatus } from '../../../order/entities/route-plan.entity';

export class RouteSheetStopDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ description: 'Orden en la hoja (1 = primera)' })
  sequence!: number;
  @ApiProperty({
    description:
      'El administrador fijó la posición: el optimizador no la mueve',
  })
  locked!: boolean;
  @ApiProperty({ type: String, nullable: true }) customerName!: string | null;
  @ApiProperty({ type: String, nullable: true }) customerPhone!: string | null;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
  @ApiProperty({ type: Number, nullable: true }) lat!: number | null;
  @ApiProperty({ type: Number, nullable: true }) lng!: number | null;
  @ApiProperty({ type: String, nullable: true, example: 'Mañana' }) slotName!:
    | string
    | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  slotStart!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) slotEnd!:
    | string
    | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Llegada estimada vigente',
  })
  etaAt!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Llegada prometida (congelada al confirmar)',
  })
  plannedEtaAt!: string | null;
  @ApiProperty({ description: 'Kilómetros desde la parada anterior' })
  legDistanceKm!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Minutos desde la parada anterior',
  })
  legDurationMin!: number | null;
  @ApiProperty({ description: 'Llegaría después de que cierra su franja' })
  late!: boolean;
  @ApiProperty({ description: 'Garrafas llenas a entregar' }) units!: number;
  @ApiProperty({
    example: 1,
    description:
      'Envases vacíos a retirar en la parada: por renglón, cantidad menos los envases cobrados (el mismo `emptiesExpected` del pedido)',
  })
  emptiesExpected!: number;
  @ApiProperty({ description: 'Kilos de gas a entregar' }) weightKg!: number;
  @ApiProperty({
    description: 'Mercado Pago todavía sin pagar (entra con advertencia)',
  })
  unpaidOnline!: boolean;
}

export class RouteSheetWarningDto {
  @ApiProperty({
    enum: [
      'late_stops',
      'no_capacity',
      'capacity',
      'straight_line',
      'no_warehouse',
      'unpaid_online',
      'stops_not_plannable',
    ],
  })
  code!: string;
  @ApiProperty() message!: string;
}

export class RouteSheetTotalsDto {
  @ApiProperty() distanceKm!: number;
  @ApiProperty({ description: 'Viaje + servicio + esperas' })
  durationMin!: number;
  @ApiProperty({ description: 'Garrafas llenas a cargar' }) units!: number;
  @ApiProperty({ description: 'Pico de envases a bordo' }) peakUnits!: number;
  @ApiProperty({ description: 'Kilos de gas a cargar' }) weightKg!: number;
  @ApiProperty({
    example: 4,
    description:
      'Envases vacíos a retirar en toda la hoja (suma de `emptiesExpected` de las paradas activas)',
  })
  emptiesExpected!: number;
}

export class RouteSheetCapacityDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'null: el vehículo no tiene capacidad cargada',
  })
  kg!: number | null;
  @ApiProperty({ type: Number, nullable: true }) units!: number | null;
}

export class RouteSheetDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Número de hoja: se asigna al confirmar',
  })
  number!: number | null;
  @ApiProperty({ example: '2026-11-14' }) planDate!: string;
  @ApiProperty({
    enum: [
      RouteBatchStatus.DRAFT,
      RouteBatchStatus.CONFIRMED,
      RouteBatchStatus.ASSIGNED,
      RouteBatchStatus.COMPLETED,
      RouteBatchStatus.DISSOLVED,
    ],
  })
  status!: RouteBatchStatus;
  @ApiProperty({
    description: 'Versión: toda edición la manda y recibe 409 si cambió',
  })
  version!: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) deliveryId!:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true }) driverName!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) carId!:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true }) carPatent!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  originWarehouseId!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  plannedStartAt!: string | null;
  @ApiProperty({ type: String, enum: ['system', 'admin'], nullable: true })
  proposedBy!: string | null;
  @ApiProperty({ type: String, enum: ['nn_2opt', 'manual'], nullable: true })
  optimizationMethod!: string | null;
  @ApiProperty({
    type: String,
    enum: ['osrm', 'google', 'haversine'],
    nullable: true,
  })
  matrixSource!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  editedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  confirmedAt!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo los pedidos quedaron asignados al chofer (al confirmar una hoja de hoy, o al empezar el día del reparto)',
  })
  assignedAt!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo el chofer inició el viaje',
  })
  startedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt!: string | null;
  @ApiProperty({
    type: String,
    enum: ['admin', 'day_closed', 'exhausted', 'orders_unavailable'],
    nullable: true,
  })
  closeReason!: string | null;
  @ApiProperty({ type: RouteSheetTotalsDto }) totals!: RouteSheetTotalsDto;
  @ApiProperty({ type: RouteSheetCapacityDto })
  capacity!: RouteSheetCapacityDto;
  @ApiProperty({ type: [RouteSheetStopDto] }) stops!: RouteSheetStopDto[];
  @ApiProperty({ type: [RouteSheetWarningDto] })
  warnings!: RouteSheetWarningDto[];
}

export class RouteSheetPageDto {
  @ApiProperty({ type: [RouteSheetDto] }) items!: RouteSheetDto[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}

export class RouteSheetMoveResponseDto {
  @ApiProperty({ type: RouteSheetDto }) source!: RouteSheetDto;
  @ApiProperty({ type: RouteSheetDto }) target!: RouteSheetDto;
}

export class RouteOrderSummaryDto {
  @ApiProperty() durationMin!: number;
  @ApiProperty() distanceKm!: number;
  @ApiProperty() lateStops!: number;
}

export class RouteSheetOptimizeResponseDto {
  @ApiProperty({ type: RouteOrderSummaryDto }) before!: RouteOrderSummaryDto;
  @ApiProperty({ type: RouteOrderSummaryDto }) after!: RouteOrderSummaryDto;
  @ApiProperty({ type: RouteSheetDto }) sheet!: RouteSheetDto;
}

export class RouteSheetViolationDto {
  @ApiProperty({
    enum: [
      'driver_missing',
      'car_missing',
      'no_stops',
      'driver_unavailable',
      'car_unavailable',
      'driver_taken',
      'car_taken',
      'capacity_kg',
      'capacity_units',
      'late_stops',
      'stops_not_plannable',
    ],
  })
  code!: string;
  @ApiProperty() message!: string;
  @ApiPropertyOptional({ type: [String] }) orderIds?: string[];
}

export class RouteSheetNotConfirmableDto {
  @ApiProperty({ example: 409 }) statusCode!: number;
  @ApiProperty() message!: string;
  @ApiProperty({ example: 'ROUTE_SHEET_NOT_CONFIRMABLE' }) code!: string;
  @ApiProperty({ type: [RouteSheetViolationDto] })
  violations!: RouteSheetViolationDto[];
}

export class RoutePlanSummaryDto {
  @ApiProperty() candidates!: number;
  @ApiProperty() sheets!: number;
  @ApiProperty() unassigned!: number;
  @ApiProperty() method!: string;
  @ApiProperty() matrixSource!: string;
}

export class RoutePlanDto {
  @ApiProperty({ example: '2026-11-14' }) date!: string;
  @ApiProperty({ enum: RoutePlanStatus }) status!: RoutePlanStatus;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Cierre de la planificación (D−1 a la hora del parámetro)',
  })
  cutoffAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  proposedAt!: string | null;
  @ApiProperty({ type: RoutePlanSummaryDto, nullable: true })
  summary!: RoutePlanSummaryDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt!: string | null;
}

export class UnassignedOrderDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ type: String, nullable: true }) customerName!: string | null;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
  @ApiProperty({ type: Number, nullable: true }) lat!: number | null;
  @ApiProperty({ type: Number, nullable: true }) lng!: number | null;
  @ApiProperty({ type: String, nullable: true }) slotName!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  slotStart!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) slotEnd!:
    | string
    | null;
  @ApiProperty() units!: number;
  @ApiProperty() weightKg!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Por qué no puede ir en una hoja (null: se puede agregar)',
  })
  blockedReason!: string | null;
}

export class DriverResourceDto {
  @ApiProperty({ format: 'uuid' }) deliveryId!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ description: 'Habilitado para repartir' }) available!: boolean;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Hoja confirmada o en curso de ese día',
  })
  busySheetId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) usualCarId!:
    | string
    | null;
}

export class CarResourceDto {
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ type: String, nullable: true }) patent!: string | null;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ type: Number, nullable: true }) capacityKg!: number | null;
  @ApiProperty({ type: Number, nullable: true }) capacityUnits!: number | null;
  @ApiProperty() available!: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) busySheetId!:
    | string
    | null;
}

export class RoutePlanResourcesDto {
  @ApiProperty({ type: [DriverResourceDto] }) drivers!: DriverResourceDto[];
  @ApiProperty({ type: [CarResourceDto] }) cars!: CarResourceDto[];
}

export class RoutePlanDayDto {
  @ApiProperty({ type: RoutePlanDto }) plan!: RoutePlanDto;
  @ApiProperty({
    type: [RouteSheetDto],
    description: 'Hojas vivas del día (sin las canceladas)',
  })
  sheets!: RouteSheetDto[];
  @ApiProperty({
    type: [UnassignedOrderDto],
    description: 'Columna «Sin asignar»',
  })
  unassigned!: UnassignedOrderDto[];
  @ApiProperty({ type: RoutePlanResourcesDto })
  resources!: RoutePlanResourcesDto;
  @ApiProperty({
    example: 12,
    description:
      'Envases vacíos a retirar en el día: suma de `totals.emptiesExpected` de las hojas de `sheets`',
  })
  emptiesExpected!: number;
}

export class ProposedSheetDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null en una corrida de prueba',
  })
  sheetId!: string | null;
  @ApiProperty({ format: 'uuid' }) deliveryId!: string;
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ type: [String] }) orderIds!: string[];
  @ApiProperty() distanceKm!: number;
  @ApiProperty() durationMin!: number;
  @ApiProperty() units!: number;
  @ApiProperty() peakUnits!: number;
  @ApiProperty() weightKg!: number;
}

export class ProposalUnassignedDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({
    enum: [
      'capacity',
      'window',
      'window_unverified',
      'no_point',
      'no_vehicles',
      'not_plannable',
      'dispatch_offer',
      'in_route',
    ],
    description:
      '`in_route`: mientras se armaba la propuesta, el administrador lo puso en otra hoja',
  })
  reason!: string;
}

export class RoutePlanProposalDto {
  @ApiProperty() dryRun!: boolean;
  @ApiProperty() candidates!: number;
  @ApiProperty({ enum: ['osrm', 'haversine'] }) matrixSource!: string;
  @ApiProperty({ type: [ProposedSheetDto] }) sheets!: ProposedSheetDto[];
  @ApiProperty({ type: [ProposalUnassignedDto] })
  unassigned!: ProposalUnassignedDto[];
  @ApiProperty({
    type: [String],
    description: 'Hojas que se conservaron (confirmadas o tocadas a mano)',
  })
  keptSheetIds!: string[];
}

export class ConfirmAllFailureDto {
  @ApiProperty({ format: 'uuid' }) sheetId!: string;
  @ApiProperty() message!: string;
  @ApiProperty({ type: [RouteSheetViolationDto] })
  violations!: RouteSheetViolationDto[];
}

export class ConfirmAllResponseDto {
  @ApiProperty({ type: [String] }) confirmed!: string[];
  @ApiProperty({ type: [ConfirmAllFailureDto] })
  failed!: ConfirmAllFailureDto[];
}

export class LateOrderSuggestionDto {
  @ApiProperty({ format: 'uuid' }) sheetId!: string;
  @ApiProperty({ description: 'Posición sugerida (1 = primera)' })
  position!: number;
  @ApiProperty({ description: 'Minutos que se corre el fin de la hoja' })
  addedMinutes!: number;
}

export class LateOrderDto extends UnassignedOrderDto {
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: LateOrderSuggestionDto, nullable: true })
  suggestion!: LateOrderSuggestionDto | null;
}

export class LoadSuggestionItemDto {
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ type: String, nullable: true }) type!: string | null;
  @ApiProperty({ description: 'Llenas a cargar' }) fullUnits!: number;
  @ApiProperty({ description: 'Vacías que vuelven del canje' })
  emptyUnitsBack!: number;
}

export class LoadSuggestionDto {
  @ApiProperty({ format: 'uuid' }) sheetId!: string;
  @ApiProperty({ type: [LoadSuggestionItemDto] })
  items!: LoadSuggestionItemDto[];
}
