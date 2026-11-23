import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { BoardColumn, BoardMoveTarget } from '../domain/task-board';
import { MaintenanceDocumentKind } from '../entities/maintenance-plan.entity';
import { MaintenanceTaskStatus } from '../entities/maintenance-task.entity';

const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Filtros del tablero (`GET /v2/fleet/tasks/board`). */
export class FleetTaskBoardQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Sólo las del vehículo' })
  @IsOptional()
  @IsUUID()
  carId?: string;

  @ApiPropertyOptional({
    enum: MaintenanceDocumentKind,
    description:
      'Tipo de tarea (el `documentKind` del plan). `generic` incluye las de planes sin tipo',
  })
  @IsOptional()
  @IsEnum(MaintenanceDocumentKind)
  category?: MaintenanceDocumentKind;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sólo las de ese empleado: las que tiene como responsable o las de su legajo',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2026-12-31',
    description: 'Sólo las que vencen hasta ese día inclusive',
  })
  @IsOptional()
  @IsDateString()
  dueBefore?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: '2026-10-18T00:00:00.000Z',
    description:
      'Desde cuándo entran las hechas (por la fecha en que se hicieron). Por omisión, los últimos 30 días',
  })
  @IsOptional()
  @IsDateString()
  doneSince?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    example: 'AB123CD',
    description:
      'Texto en el nombre del plan, la patente, la marca o el modelo, el responsable, el proveedor, la referencia o las notas',
  })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(100)
  q?: string;
}

/** `POST /v2/fleet/tasks/:id/move`. */
export class MoveFleetTaskDto {
  @ApiProperty({
    enum: BoardMoveTarget,
    description:
      'Columna de destino. A «hecha» no se mueve por acá (se cierra con `POST /v2/fleet/tasks/:id/close`) y cancelar va por `PATCH /fleet/tasks/:id/cancel`',
  })
  @IsEnum(BoardMoveTarget)
  to!: BoardMoveTarget;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: '2026-12-02',
    description:
      'Turno. Obligatorio al pasar de `forecast` a `scheduled`; opcional al ir a `scheduled` desde `scheduled` o `in_progress` (reprograma, y mueve la ventana confirmada del planificador). En otro destino, 400. Un `YYYY-MM-DD` es ese día argentino. `null` cuenta como ausente: el turno se borra sólo yendo a `forecast`',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === null ? undefined : value,
  )
  @IsDateString()
  scheduledAt?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'La tarjeta queda inmediatamente ANTES de esta (de la misma columna de destino y la misma empresa)',
  })
  @IsOptional()
  @IsUUID()
  beforeId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'La tarjeta queda inmediatamente DESPUÉS de esta (de la misma columna de destino y la misma empresa). Sin `beforeId` ni `afterId`, al final de la columna',
  })
  @IsOptional()
  @IsUUID()
  afterId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'Precondición: el `updatedAt` de la tarjeta que tiene el panel. Si la tarea cambió, 409 `FLEET_TASK_STALE`. También se acepta en el header `If-Match`',
  })
  @IsOptional()
  @IsDateString()
  expectedUpdatedAt?: string;
}

export class FleetTaskBoardCarDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true, example: 'AB123CD' })
  plate!: string | null;
  @ApiProperty({
    example: 'Ford Cargo 1722',
    description: 'Marca y modelo; si no hay, el tipo de vehículo o la patente',
  })
  label!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Foto del vehículo: URL firmada de corta vigencia, o null',
  })
  photoUrl!: string | null;
}

export class FleetTaskBoardAssigneeDto {
  @ApiProperty({ format: 'uuid' }) employeeId!: string;
  @ApiProperty({ example: 'Pérez, Juan' }) name!: string;
}

/** Una tarjeta del tablero. */
export class FleetTaskBoardCardDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'VTV', description: 'El nombre del plan' })
  title!: string;
  @ApiProperty({
    enum: MaintenanceDocumentKind,
    description:
      'Tipo de tarea (el `documentKind` del plan; `generic` si no tiene)',
  })
  category!: MaintenanceDocumentKind;
  @ApiProperty({ enum: MaintenanceTaskStatus }) status!: MaintenanceTaskStatus;
  @ApiProperty({
    enum: BoardColumn,
    nullable: true,
    description: 'La columna donde va (`null` si está cancelada)',
  })
  column!: BoardColumn | null;
  @ApiProperty({
    description:
      'Abierta y con el vencimiento ya pasado (o con estado `overdue`). No cambia de columna',
  })
  isOverdue!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  dueAt!: Date | null;
  @ApiProperty({ type: Number, nullable: true }) dueKm!: number | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  scheduledAt!: Date | null;
  @ApiProperty({ type: FleetTaskBoardCarDto, nullable: true })
  car!: FleetTaskBoardCarDto | null;
  @ApiProperty({ type: FleetTaskBoardAssigneeDto, nullable: true })
  assignee!: FleetTaskBoardAssigneeDto | null;
  @ApiProperty({ example: 2 }) attachmentsCount!: number;
  @ApiProperty({ type: Number, nullable: true, example: 185000 })
  cost!: number | null;
  @ApiProperty({
    example: 2048,
    description: 'Orden dentro de la columna (ascendente)',
  })
  position!: number;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'La precondición para mover o editar (`expectedUpdatedAt`)',
  })
  updatedAt!: Date;
}

export class FleetTaskBoardColumnsDto {
  @ApiProperty({ type: FleetTaskBoardCardDto, isArray: true })
  forecast!: FleetTaskBoardCardDto[];
  @ApiProperty({ type: FleetTaskBoardCardDto, isArray: true })
  scheduled!: FleetTaskBoardCardDto[];
  @ApiProperty({ type: FleetTaskBoardCardDto, isArray: true })
  in_progress!: FleetTaskBoardCardDto[];
  @ApiProperty({
    type: FleetTaskBoardCardDto,
    isArray: true,
    description:
      'Las hechas desde `doneSince` (30 días por omisión), la más reciente primero',
  })
  done!: FleetTaskBoardCardDto[];
}

export class FleetTaskBoardDto {
  @ApiProperty({ type: FleetTaskBoardColumnsDto })
  columns!: FleetTaskBoardColumnsDto;
  @ApiProperty({
    example: 3,
    description: 'Canceladas con los mismos filtros (no tienen columna)',
  })
  cancelledCount!: number;
}

/** Qué le pasó a la tarea, en el evento `fleet:task` del socket del panel. */
export enum FleetTaskChange {
  CREATED = 'created',
  MOVED = 'moved',
  UPDATED = 'updated',
  CLOSED = 'closed',
  CANCELLED = 'cancelled',
  OVERDUE = 'overdue',
  /** La columna se renumeró: la tarjeta cambió de `position` (no de `updatedAt`). */
  REORDERED = 'reordered',
}

/** Carga del evento `fleet:task` (sala del panel de la empresa). */
export class FleetTaskBoardEventDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: FleetTaskChange }) change!: FleetTaskChange;
  @ApiProperty({ type: FleetTaskBoardCardDto }) card!: FleetTaskBoardCardDto;
}
