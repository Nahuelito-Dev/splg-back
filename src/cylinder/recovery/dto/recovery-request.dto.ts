import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../../common/dtos/pagination.dto';
import { TextoNoVacio } from '../../../common/decorators/texto-no-vacio.decorator';
import { RecoveryCaseStatus } from '../../entities/cylinder-recovery-case.entity';

/** Largo mínimo de la nota de la decisión (también en la base). */
export const NOTA_MINIMA = 10;

/** Lo que decide el administrador sobre un caso escalado o perdido (CU-108, paso 11). */
export enum RecoveryDecision {
  /** Registra el depósito a cobrar; el cobro se hace aparte (próximo pedido o efectivo). */
  CHARGE_DEPOSIT = 'charge_deposit',
  /** Da el envase por perdido y lo saca del inventario. */
  WRITE_OFF = 'write_off',
  /** Cierra el caso sin cargo para el cliente. */
  CLOSE_NO_CHARGE = 'close_no_charge',
}

export class QueryRecoveryCasesDto extends PaginationDto {
  @ApiPropertyOptional({ enum: RecoveryCaseStatus })
  @IsOptional()
  @IsEnum(RecoveryCaseStatus)
  status?: RecoveryCaseStatus;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 3,
    description: 'Escalón: 1 recordatorio, 2 aviso del depósito, 3 agotado',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3)
  step?: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'user_id del cliente' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cylinderId?: string;

  @ApiPropertyOptional({
    description:
      'Sólo los casos que siguen en pie (abiertos, escalados o perdidos)',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  live?: boolean;

  @ApiPropertyOptional({
    description:
      'Sólo los casos que esperan la decisión del administrador (escalados o perdidos)',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  pending?: boolean;
}

export class ResolveRecoveryCaseDto {
  @ApiProperty({ enum: RecoveryDecision })
  @IsEnum(RecoveryDecision)
  decision!: RecoveryDecision;

  @ApiProperty({
    maxLength: 500,
    example:
      'El cliente reconoce que lo extravió; se cobra con el próximo pedido',
    minLength: 10,
    description:
      'Obligatoria, de 10 a 500 caracteres: queda en el caso junto con quién decidió',
  })
  @TextoNoVacio()
  @MinLength(NOTA_MINIMA)
  @MaxLength(500)
  note!: string;
}

/** Parámetros del módulo a cambiar; lo que no viene queda como estaba. */
export class PatchRecoverySettingsDto {
  @ApiPropertyOptional({
    description:
      'Días desde la entrega para considerar retenido el envase (1 a 365)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  toleranceDays?: number;

  @ApiPropertyOptional({
    description: 'Duración de cada escalón, en días (1 a 90)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  escalationStepDays?: number;

  @ApiPropertyOptional({
    description: 'Depósito desde el cual el caso escala (0 a 100000000)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100_000_000)
  escalationAmountThreshold?: number;

  @ApiPropertyOptional({
    description: 'Vigencia de la oferta de retiro, en horas (1 a 720)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  pickupOfferTtlHours?: number;

  @ApiPropertyOptional({
    description:
      'Ventana, en días, en que una entrega programada sirve para el retiro (1 a 60)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  pickupWindowDays?: number;

  @ApiPropertyOptional({
    description: 'Hora de ejecución diaria (0 a 23, hora de Argentina)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  runHour?: number;

  @ApiPropertyOptional({
    description:
      'Encender el recupero (1) o apagarlo (0). Apagado por omisión: no abre casos ni manda avisos, y «correr ahora» responde 409',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1)
  enabled?: number;
}

/** El chofer no pudo retirar el envase en la entrega. */
export class PickupNotCollectedDto {
  @ApiProperty({ maxLength: 500, example: 'El cliente no estaba en casa' })
  @TextoNoVacio()
  @MaxLength(500)
  reason!: string;
}

export class RecoveryNoticeParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  noticeId!: string;
}
