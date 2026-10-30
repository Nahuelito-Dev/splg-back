import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { CashDirection } from '../../cash/domain/cash.enums';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { FechaCalendario } from '../../employee/dto/fecha-calendario.decorator';
import {
  MpDifferenceKind,
  MpItemStatus,
  MpReconciliationStatus,
} from '../domain/mp-reconciliation.enums';

/** Máximo de días de un rango (el reporte de Mercado Pago admite hasta 60). */
export const MAX_DIAS_DE_CONCILIACION = 31;

export class CreateMpReconciliationDto {
  @FechaCalendario('2026-10-01')
  from!: string;

  @FechaCalendario('2026-10-31')
  to!: string;
}

export class QueryMpReconciliationDto extends PaginationDto {
  @ApiPropertyOptional({ enum: MpReconciliationStatus })
  @IsOptional()
  @IsEnum(MpReconciliationStatus)
  status?: MpReconciliationStatus;
}

export class ApplyMpItemDto {
  @ApiProperty({ format: 'uuid', description: 'Diferencia a asentar' })
  @IsUUID()
  itemId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Caja de destino. Sólo los retiros (`payout`) la piden: la caja a la que llegó el dinero que salió de la billetera.',
  })
  @IsOptional()
  @IsUUID()
  cashBoxId?: string;
}

export class ApplyMpReconciliationDto {
  @ApiProperty({ type: [ApplyMpItemDto], minItems: 1, maxItems: 200 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ApplyMpItemDto)
  items!: ApplyMpItemDto[];

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Distribuidora a la que se asientan las diferencias de la cuenta (retiros, impuestos sueltos): obligatoria si alguna lo es, y tiene que ser la de la corrida. Esas filas se asientan una sola vez en todo el sistema.',
  })
  @IsOptional()
  @IsUUID()
  distributorId?: string;
}

export class MpSummaryMpDto {
  @ApiProperty({ example: 120000 }) gross!: number;
  @ApiProperty({ example: 4800 }) fees!: number;
  @ApiProperty({ example: 1200 }) taxes!: number;
  @ApiProperty({
    example: 114000,
    description: 'Créditos menos débitos de los cobros de la distribuidora',
  })
  net!: number;
}

export class MpSummaryCashDto {
  @ApiProperty({ example: 120000 }) income!: number;
  @ApiProperty({ example: 6000 }) expense!: number;
  @ApiProperty({ example: 114000 }) net!: number;
}

export class MpSummaryAccountDto {
  @ApiProperty({ example: 12 }) rows!: number;
  @ApiProperty({ example: 50000 }) credit!: number;
  @ApiProperty({ example: 50000 }) debit!: number;
}

export class MpSummaryDto {
  @ApiProperty({
    example: 40,
    description: 'Filas de movimiento que ve la distribuidora',
  })
  rows!: number;
  @ApiProperty({
    type: MpSummaryMpDto,
    description: 'Lo que informa Mercado Pago',
  })
  mp!: MpSummaryMpDto;
  @ApiProperty({
    type: MpSummaryCashDto,
    description: 'Lo que tiene la caja de Mercado Pago en el rango',
  })
  cash!: MpSummaryCashDto;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description: 'Cantidad de diferencias pendientes o aplicadas, por tipo',
  })
  differences!: Record<string, number>;
  @ApiProperty({
    example: 2,
    description: 'Filas que ya se habían asentado en otra corrida',
  })
  alreadyApplied!: number;
  @ApiProperty({
    example: 0,
    description: 'Filas del archivo que no se pudieron leer',
  })
  unreadableRows!: number;
  @ApiPropertyOptional({
    type: MpSummaryAccountDto,
    description:
      'Sólo para el super admin: movimientos de la cuenta que no son de ninguna distribuidora',
  })
  account?: MpSummaryAccountDto;
}

export class MpReconciliationResponseDto {
  @ApiProperty({ format: 'uuid' }) reconciliationId!: string;
  @ApiProperty({
    format: 'uuid',
    description:
      'Distribuidora de la conciliación (la que se manda como `distributorId` al asentar diferencias de la cuenta)',
  })
  distributorId!: string;
  @ApiProperty({ example: '2026-10-01', format: 'date' }) from!: string;
  @ApiProperty({ example: '2026-10-31', format: 'date' }) to!: string;
  @ApiProperty({
    enum: MpReconciliationStatus,
    enumName: 'MpReconciliationStatus',
  })
  status!: MpReconciliationStatus;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Por qué falló, si falló',
  })
  failureReason!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Mientras espera el reporte: qué pasa (todavía no se consultó, Mercado Pago aún no lo generó, el último error del intento). Null en las demás.',
  })
  statusNote!: string | null;
  @ApiProperty({
    type: MpSummaryDto,
    nullable: true,
    description: 'Null hasta que el reporte está listo',
  })
  summary!: MpSummaryDto | null;
  @ApiProperty({
    description: 'El archivo del reporte está guardado y se puede bajar',
  })
  hasReport!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readyAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastCheckedAt!: Date | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({
    description:
      'La corrida incluye los movimientos de la cuenta que no son de ninguna distribuidora (la pidió un super admin)',
  })
  includesAccountLevel!: boolean;
}

export class MpReconciliationPageDto {
  @ApiProperty({ type: [MpReconciliationResponseDto] })
  data!: MpReconciliationResponseDto[];
  @ApiProperty({ example: 3 }) total!: number;
}

export class MpReconciliationItemResponseDto {
  @ApiProperty({ format: 'uuid' }) itemId!: string;
  @ApiProperty({ enum: MpDifferenceKind, enumName: 'MpDifferenceKind' })
  kind!: MpDifferenceKind;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Id del movimiento en Mercado Pago',
  })
  sourceId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  paymentId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  orderId!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  occurredAt!: Date | null;
  @ApiProperty({
    example: 'payment',
    description: 'Tipo de movimiento según Mercado Pago',
  })
  mpDescription!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Importe según Mercado Pago',
  })
  mpAmount!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Importe según la caja',
  })
  ledgerAmount!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  difference!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Comisión que acompaña al cobro o al retiro',
  })
  extraAmount!: number | null;
  @ApiProperty({
    enum: CashDirection,
    enumName: 'CashDirection',
    nullable: true,
  })
  direction!: CashDirection | null;
  @ApiProperty({ description: 'Se puede asentar desde acá' })
  appliable!: boolean;
  @ApiProperty({
    description: 'Pide la caja de destino al aplicarse (retiros)',
  })
  needsCashBox!: boolean;
  @ApiProperty({ description: 'Sólo la ve el super admin' })
  accountLevel!: boolean;
  @ApiProperty() note!: string;
  @ApiProperty({ enum: MpItemStatus, enumName: 'MpItemStatus' })
  status!: MpItemStatus;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  appliedAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  appliedMovementId!: string | null;
}

export class MpReconciliationDetailResponseDto extends MpReconciliationResponseDto {
  @ApiProperty({ type: [MpReconciliationItemResponseDto] })
  items!: MpReconciliationItemResponseDto[];
}

export type MpApplyOutcome = 'applied' | 'already_applied' | 'failed';

export class MpApplyItemResultDto {
  @ApiProperty({ format: 'uuid' }) itemId!: string;
  @ApiProperty({ enum: ['applied', 'already_applied', 'failed'] })
  outcome!: MpApplyOutcome;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Por qué no se asentó',
  })
  message!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  movementId!: string | null;
}

export class MpApplyResponseDto {
  @ApiProperty({ example: 3 }) applied!: number;
  @ApiProperty({ example: 0 }) alreadyApplied!: number;
  @ApiProperty({ example: 1 }) failed!: number;
  @ApiProperty({ type: [MpApplyItemResultDto] })
  results!: MpApplyItemResultDto[];
}
