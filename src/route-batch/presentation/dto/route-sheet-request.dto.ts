import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PaginationDto } from '../../../common/dtos/pagination.dto';
import { RouteBatchStatus } from '../../domain/route-batch.enums';

const FORMATO_FECHA = /^\d{4}-\d{2}-\d{2}$/;
/** El tope de paradas por hoja del parámetro (40); un pedido más es siempre inválido. */
const MAX_PARADAS = 40;

/** El día del path (`/route-plans/:date`). */
export class RoutePlanDateParamDto {
  @ApiProperty({
    example: '2026-11-14',
    description: 'Día de reparto (YYYY-MM-DD, hora argentina)',
  })
  @Matches(FORMATO_FECHA, {
    message: 'La fecha tiene que tener el formato AAAA-MM-DD',
  })
  @IsDateString({ strict: true }, { message: 'La fecha no es válida' })
  date!: string;
}

export class ProposeRoutePlanDto {
  @ApiPropertyOptional({
    default: false,
    description: 'true: calcula la propuesta y la devuelve sin crear hojas',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class CreateRouteSheetDto {
  @ApiProperty({ example: '2026-11-14' })
  @Matches(FORMATO_FECHA, {
    message: 'La fecha de reparto tiene que tener el formato AAAA-MM-DD',
  })
  @IsDateString(
    { strict: true },
    { message: 'La fecha de reparto no es válida' },
  )
  planDate!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Chofer (`delivery_id`)',
  })
  @IsOptional()
  @IsUUID()
  deliveryId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  carId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Pedidos del día, en el orden de entrega',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(MAX_PARADAS)
  @IsUUID('all', { each: true })
  orderIds?: string[];
}

/** Toda edición manda la versión de la hoja que vio (409 si cambió). */
export class VersionRouteSheetDto {
  @ApiProperty({
    minimum: 1,
    description: 'Versión de la hoja que vio quien edita',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

export class UpdateRouteSheetDto extends VersionRouteSheetDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  deliveryId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  carId?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Hora de salida prevista',
  })
  @IsOptional()
  @IsDateString(
    { strict: true },
    { message: 'La hora de salida no es una fecha y hora válida' },
  )
  plannedStartAt?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Depósito de salida' })
  @IsOptional()
  @IsUUID()
  originWarehouseId?: string;
}

export class AddRouteSheetStopDto extends VersionRouteSheetDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  orderId!: string;

  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Posición (1 = primera). Sin posición: la inserción más barata que respeta franjas y capacidad',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PARADAS)
  position?: number;

  @ApiPropertyOptional({
    default: false,
    description: 'Fija la posición: el optimizador no la mueve',
  })
  @IsOptional()
  @IsBoolean()
  lock?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Acepta que la parada quede fuera de franja (en la posición pedida o, sin posición, donde menos se atrasa) en vez de responder 409. La capacidad del vehículo no se puede saltear',
  })
  @IsOptional()
  @IsBoolean()
  acceptLateStops?: boolean;
}

export class MoveRouteSheetStopDto extends VersionRouteSheetDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  targetSheetId!: string;

  @ApiProperty({ minimum: 1, description: 'Versión de la hoja de destino' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetVersion!: number;

  @ApiPropertyOptional({
    minimum: 1,
    description: 'Posición en la hoja de destino (sin ella: la más barata)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PARADAS)
  position?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'Acepta que la parada (u otras de la hoja de destino) quede fuera de franja; sin esto, 409 ROUTE_STOP_NOT_FEASIBLE',
  })
  @IsOptional()
  @IsBoolean()
  acceptLateStops?: boolean;
}

export class SetRouteSheetSequenceDto extends VersionRouteSheetDto {
  @ApiProperty({
    type: [String],
    description: 'Exactamente las paradas de la hoja, en el orden nuevo',
  })
  @IsArray()
  @ArrayMaxSize(MAX_PARADAS)
  @IsUUID('all', { each: true })
  orderIds!: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'Paradas cuya posición queda fija (reemplaza a las fijadas antes; sin el campo se conservan)',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(MAX_PARADAS)
  @IsUUID('all', { each: true })
  locked?: string[];
}

export class ConfirmRouteSheetDto extends VersionRouteSheetDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Confirma aunque haya paradas que llegan fuera de su franja (quedan advertidas)',
  })
  @IsOptional()
  @IsBoolean()
  acceptLateStops?: boolean;
}

export class QueryRouteSheetsDto extends PaginationDto {
  @ApiPropertyOptional({ example: '2026-11-14' })
  @IsOptional()
  @Matches(FORMATO_FECHA, {
    message: 'La fecha tiene que tener el formato AAAA-MM-DD',
  })
  @IsDateString({ strict: true }, { message: 'La fecha no es válida' })
  date?: string;

  @ApiPropertyOptional({
    enum: [
      RouteBatchStatus.DRAFT,
      RouteBatchStatus.CONFIRMED,
      RouteBatchStatus.ASSIGNED,
      RouteBatchStatus.COMPLETED,
      RouteBatchStatus.DISSOLVED,
    ],
  })
  @IsOptional()
  @IsIn([
    RouteBatchStatus.DRAFT,
    RouteBatchStatus.CONFIRMED,
    RouteBatchStatus.ASSIGNED,
    RouteBatchStatus.COMPLETED,
    RouteBatchStatus.DISSOLVED,
  ])
  status?: RouteBatchStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  deliveryId?: string;
}

/** Parámetros de la hoja de ruta (§3.5). Los rangos son los del esquema y del CHECK de la base. */
export class PatchRoutePlanningSettingsDto {
  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1,
    description: '1 enciende la hoja de ruta',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1)
  enabled?: number;
  @ApiPropertyOptional({
    minimum: 0,
    maximum: 23,
    description: 'Hora del cierre del día anterior',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  cutoffHour?: number;
  @ApiPropertyOptional({ minimum: 0, maximum: 59 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(59)
  cutoffMinute?: number;
  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1,
    description: 'Al cierre, el sistema arma la propuesta solo',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1)
  autoPropose?: number;
  @ApiPropertyOptional({ minimum: 2, maximum: 40 })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(40)
  maxStopsPerSheet?: number;
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 60,
    description: 'Minutos por parada',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  serviceMinutes?: number;
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 3,
    description: 'Multiplica los tiempos de OSRM',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(3)
  trafficFactor?: number;
  @ApiPropertyOptional({ minimum: 10, maximum: 120 })
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(120)
  etaWindowMinutes?: number;
  @ApiPropertyOptional({ minimum: 30, maximum: 900 })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(900)
  etaRecalcMinSeconds?: number;
  @ApiPropertyOptional({ minimum: 50, maximum: 5000 })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(5000)
  etaRecalcMinMeters?: number;
  @ApiPropertyOptional({ minimum: 5, maximum: 120 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(120)
  etaNotifyShiftMinutes?: number;
  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1,
    description: '0: el tardío va a M1; 1: se sugiere la hoja',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1)
  lateOrderPolicy?: number;
  @ApiPropertyOptional({ minimum: 0, maximum: 240 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  notStartedAlertMinutes?: number;
}
