import { ApiProperty } from '@nestjs/swagger';
import { TruckLoadStatus } from '../../truck-load/domain/truck-load.enums';

const LIVE_VEHICLE_STATUS = ['on_route', 'waiting'] as const;
const LIVE_STOP_PROGRESS = [
  'pending',
  'on_the_way',
  'delivered',
  'failed',
] as const;
const LIVE_STOP_SOURCE = ['route_sheet', 'order'] as const;
const LIVE_SHEET_STATUS = ['confirmed', 'assigned'] as const;
const OPEN_LOAD_STATUS = [
  TruckLoadStatus.LOADING,
  TruckLoadStatus.ON_ROUTE,
  TruckLoadStatus.RETURNED,
] as const;

export class LiveVehicleDriverDto {
  @ApiProperty({ format: 'uuid' }) deliveryId!: string;
  @ApiProperty({
    format: 'uuid',
    description:
      'Usuario del chofer: el `driverId` de `order:driver-location` y el `driverUserId` de `route-sheet:driver-location`',
  })
  userId!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '+5493764123456' })
  phone!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Foto del chofer: URL firmada de corta vigencia, o null',
  })
  photoUrl!: string | null;
}

export class LiveVehicleLoadDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Carga abierta del vehículo, si tiene',
  })
  truckLoadId!: string | null;
  @ApiProperty({ type: Number, nullable: true })
  truckLoadNumber!: number | null;
  @ApiProperty({ enum: OPEN_LOAD_STATUS, nullable: true })
  truckLoadStatus!: (typeof OPEN_LOAD_STATUS)[number] | null;
  @ApiProperty({ description: 'Garrafas llenas a bordo', example: 20 })
  fullUnits!: number;
  @ApiProperty({ description: 'Envases vacíos a bordo', example: 12 })
  emptyUnits!: number;
  @ApiProperty({ description: 'Envases defectuosos a bordo', example: 0 })
  defectiveUnits!: number;
  @ApiProperty({
    description: 'Envases a bordo: llenos, vacíos y defectuosos',
    example: 32,
  })
  unitsOnBoard!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Garrafas que entran en el vehículo; null si no tiene la capacidad cargada',
    example: 40,
  })
  capacityUnits!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Ocupación: envases a bordo sobre la capacidad, en por ciento (puede pasar de 100); null sin capacidad cargada',
    example: 80,
  })
  percent!: number | null;
}

export class LiveVehicleSheetDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: Number, nullable: true }) number!: number | null;
  @ApiProperty({
    enum: LIVE_SHEET_STATUS,
    description: '`confirmed`: todavía no salió; `assigned`: en curso',
  })
  status!: (typeof LIVE_SHEET_STATUS)[number];
  @ApiProperty({
    format: 'date',
    example: '2026-11-21',
    description: 'Día de reparto de la hoja',
  })
  planDate!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  plannedStartAt!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo el chofer inició el viaje',
  })
  startedAt!: string | null;
  @ApiProperty({ description: 'Paradas visibles de la hoja' }) total!: number;
  @ApiProperty() delivered!: number;
  @ApiProperty() failed!: number;
  @ApiProperty({ description: 'Pendientes más la que está en camino' })
  pending!: number;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Llegada estimada a la última parada que falta; null si no queda ninguna con hora',
  })
  estimatedEndAt!: string | null;
}

export class LiveVehicleStopDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({
    enum: LIVE_STOP_SOURCE,
    description:
      '`route_sheet`: parada de la hoja; `order`: pedido en curso fuera de una hoja',
  })
  source!: (typeof LIVE_STOP_SOURCE)[number];
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Orden en la hoja (1 = primera); null si salió de la hoja o no es de una hoja',
  })
  sequence!: number | null;
  @ApiProperty({ enum: LIVE_STOP_PROGRESS })
  progress!: (typeof LIVE_STOP_PROGRESS)[number];
  @ApiProperty({ type: String, nullable: true }) customerName!: string | null;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
  @ApiProperty({ type: Number, nullable: true }) lat!: number | null;
  @ApiProperty({ type: Number, nullable: true }) lng!: number | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Llegada estimada vigente (sólo las paradas de una hoja la tienen)',
  })
  etaAt!: string | null;
}

export class LiveVehicleLocationDto {
  @ApiProperty() lat!: number;
  @ApiProperty() lng!: number;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo se registró la posición',
  })
  at!: string | null;
}

export class LiveVehicleDto {
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ type: String, nullable: true, example: 'AB104EJ' })
  patent!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'Camioneta' })
  typeCar!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Marca y modelo',
    example: 'Toyota Hilux',
  })
  description!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Foto del vehículo: URL firmada de corta vigencia, o null',
  })
  photoUrl!: string | null;
  @ApiProperty({
    enum: LIVE_VEHICLE_STATUS,
    description:
      '`on_route`: la hoja de ruta ya se inició o el chofer tiene un pedido aceptado o en camino; `waiting`: en uso, sin viaje en curso',
  })
  status!: (typeof LIVE_VEHICLE_STATUS)[number];
  @ApiProperty({
    format: 'date-time',
    description: 'Desde cuándo el chofer lo tiene en uso',
  })
  inUseSince!: string;
  @ApiProperty({ type: LiveVehicleDriverDto }) driver!: LiveVehicleDriverDto;
  @ApiProperty({ type: LiveVehicleLoadDto }) load!: LiveVehicleLoadDto;
  @ApiProperty({
    type: LiveVehicleSheetDto,
    nullable: true,
    description:
      'La hoja de ruta de hoy de este chofer con este vehículo (confirmada o en curso), si tiene',
  })
  sheet!: LiveVehicleSheetDto | null;
  @ApiProperty({
    type: [LiveVehicleStopDto],
    description:
      'Las paradas de la hoja en su orden y, después, los pedidos en curso fuera de una hoja',
  })
  stops!: LiveVehicleStopDto[];
  @ApiProperty({
    type: LiveVehicleLocationDto,
    nullable: true,
    description: 'Última posición conocida del chofer, o null',
  })
  location!: LiveVehicleLocationDto | null;
}

export class LiveFleetDto {
  @ApiProperty({ format: 'date-time' }) generatedAt!: string;
  @ApiProperty({
    type: [LiveVehicleDto],
    description: 'Primero los que están en ruta; después, por patente',
  })
  vehicles!: LiveVehicleDto[];
}
