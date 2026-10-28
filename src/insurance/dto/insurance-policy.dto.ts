import {
  ApiProperty,
  ApiPropertyOptional,
  PartialType,
  PickType,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { VacioANulo } from '../../employee/dto/vacio-a-nulo.decorator';
import { FechaCalendario } from '../../employee/dto/fecha-calendario.decorator';
import { MotivoObligatorio } from '../../purchase/dto/motivo.decorator';
import {
  DIAS_DE_GRACIA_POR_OMISION,
  InstallmentStatus,
  PolicyStatus,
} from '../domain/insurance.enums';
import { MAXIMO_DE_CUOTAS } from '../domain/installment-plan';
import { InsurerResponseDto } from './insurer.dto';

export class InstallmentPlanDto {
  @ApiProperty({ example: 6, minimum: 1, maximum: MAXIMO_DE_CUOTAS })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAXIMO_DE_CUOTAS)
  count!: number;

  @ApiProperty({ example: 29958, description: 'Importe de cada cuota' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @FechaCalendario('2026-06-22')
  firstDueDate!: string;

  @ApiPropertyOptional({
    default: DIAS_DE_GRACIA_POR_OMISION,
    minimum: 0,
    maximum: 31,
    description:
      'Días después del vencimiento en que el pago todavía se juzga en término',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(31)
  graceDays?: number;
}

export class CreateInsurancePolicyDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  carId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  insurerId!: string;

  @ApiProperty({ example: '67/02/192143', maxLength: 40 })
  @TextoNoVacio()
  @MaxLength(40)
  policyNumber!: string;

  @ApiProperty({ example: 'Todo riesgo con franquicia' })
  @TextoNoVacio()
  @MaxLength(1000)
  coverage!: string;

  @FechaCalendario('2026-06-22')
  validFrom!: string;

  @FechaCalendario('2026-12-22')
  validTo!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '0001234567890123',
    maxLength: 60,
    description: 'Código de pago electrónico (Pago Fácil, Rapipago)',
  })
  @VacioANulo()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  paymentCode?: string | null;

  @ApiProperty({
    type: InstallmentPlanDto,
    description:
      'Plan de cuotas: se generan `count` cuotas mensuales el mismo día de cada mes (si el mes no lo tiene, el último)',
  })
  @IsDefined({ message: 'installments: falta el plan de cuotas' })
  @ValidateNested()
  @Type(() => InstallmentPlanDto)
  installments!: InstallmentPlanDto;
}

/** La vigencia y el plan de cuotas no se editan: se cancela la póliza y se da de alta otra. */
export class UpdateInsurancePolicyDto extends PartialType(
  PickType(CreateInsurancePolicyDto, [
    'insurerId',
    'policyNumber',
    'coverage',
    'paymentCode',
  ] as const),
) {}

export class CancelInsurancePolicyDto {
  @ApiProperty({ example: 'Se vendió el vehículo' })
  @MotivoObligatorio()
  reason!: string;
}

export class InsuranceInstallmentResponseDto {
  @ApiProperty({ format: 'uuid' })
  installmentId!: string;

  @ApiProperty({ format: 'uuid' })
  policyId!: string;

  @ApiProperty({ example: 5 })
  number!: number;

  @ApiProperty({ example: 6 })
  total!: number;

  @ApiProperty({ example: '5/6' })
  label!: string;

  @ApiProperty({ example: '2026-11-22' })
  dueDate!: string;

  @ApiProperty({ example: '2026-11-27' })
  graceUntil!: string;

  @ApiProperty({ example: 29958 })
  amount!: number;

  @ApiProperty({ enum: InstallmentStatus })
  status!: InstallmentStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt!: Date | null;

  @ApiProperty({ type: Number, nullable: true })
  paidAmount!: number | null;

  @ApiProperty({ type: String, nullable: true })
  operationNumber!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  paidByUserId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Egreso de la caja con que se pagó',
  })
  cashMovementId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  receiptAttachmentId!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/** La cuota con la póliza y el vehículo, para el listado general. */
export class InsuranceInstallmentDetailDto extends InsuranceInstallmentResponseDto {
  @ApiProperty({ format: 'uuid' })
  carId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'OVQ621' })
  carPatent!: string | null;

  @ApiProperty({ example: '67/02/192143' })
  policyNumber!: string;

  @ApiProperty({ format: 'uuid' })
  insurerId!: string;

  @ApiProperty({ example: 'Seguros Rivadavia' })
  insurerName!: string;

  @ApiProperty({ type: String, nullable: true })
  paymentUrl!: string | null;
}

export class InsuranceInstallmentPageDto {
  @ApiProperty({ type: [InsuranceInstallmentDetailDto] })
  data!: InsuranceInstallmentDetailDto[];

  @ApiProperty()
  total!: number;
}

export class FleetSyncDto {
  @ApiProperty({
    description:
      '`true` si la tarea de seguro del vehículo quedó con el vencimiento de la póliza',
  })
  synced!: boolean;

  @ApiProperty({
    description:
      '`true` si la póliza empieza después de que vence el seguro actual de la flota: la tarea se actualiza cuando la póliza empiece (la actualiza el cron diario)',
  })
  pending!: boolean;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  taskId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Por qué no se sincronizó, si `synced` es `false`',
  })
  reason!: string | null;
}

export class InsurancePolicyResponseDto {
  @ApiProperty({ format: 'uuid' })
  policyId!: string;

  @ApiProperty({ format: 'uuid' })
  carId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'OVQ621' })
  carPatent!: string | null;

  @ApiProperty({ type: InsurerResponseDto })
  insurer!: InsurerResponseDto;

  @ApiProperty({ example: '67/02/192143' })
  policyNumber!: string;

  @ApiProperty()
  coverage!: string;

  @ApiProperty({ example: '2026-06-22' })
  validFrom!: string;

  @ApiProperty({ example: '2026-12-22' })
  validTo!: string;

  @ApiProperty({ type: String, nullable: true })
  paymentCode!: string | null;

  @ApiProperty({ enum: PolicyStatus })
  status!: PolicyStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  cancelReason!: string | null;

  @ApiProperty({ type: [InsuranceInstallmentResponseDto] })
  installments!: InsuranceInstallmentResponseDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/** Alta de póliza: la póliza con sus cuotas y lo que pasó con la tarea de seguro de flota. */
export class CreatedInsurancePolicyDto extends InsurancePolicyResponseDto {
  @ApiProperty({ type: FleetSyncDto })
  fleet!: FleetSyncDto;
}

export class CarInsuranceResponseDto {
  @ApiProperty({ format: 'uuid' })
  carId!: string;

  @ApiProperty({
    type: InsurancePolicyResponseDto,
    nullable: true,
    description:
      'La póliza que cubre hoy; si no hay, la próxima que empieza; si tampoco, `null`',
  })
  current!: InsurancePolicyResponseDto | null;

  @ApiProperty({
    type: [InsurancePolicyResponseDto],
    description:
      'Las demás pólizas (vencidas, canceladas o futuras), la más nueva primero',
  })
  history!: InsurancePolicyResponseDto[];
}

export class FleetRevertDto {
  @ApiProperty({
    description:
      '`true` si se deshizo lo que la póliza había hecho en la flota (tarea creada cancelada y anteriores reabiertas)',
  })
  reverted!: boolean;

  @ApiProperty({
    type: [String],
    description:
      'Lo que no se tocó porque alguien lo cambió mientras tanto, o por qué no se revirtió',
  })
  notes!: string[];
}

/** Cancelación de póliza: la póliza y lo que pasó con la flota. */
export class CancelledInsurancePolicyDto extends InsurancePolicyResponseDto {
  @ApiProperty({ type: FleetRevertDto })
  fleetRevert!: FleetRevertDto;
}
