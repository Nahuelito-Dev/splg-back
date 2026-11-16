import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import {
  FechaCalendario,
  FechaCalendarioOpcional,
} from '../../employee/dto/fecha-calendario.decorator';
import { MotivoObligatorio } from '../../purchase/dto/motivo.decorator';
import { LiquidationStatus } from '../domain/commission.enums';
import { CommissionEntryResponseDto } from './commission.dto';

export class CreateDriverLiquidationDto {
  @ApiProperty({ description: 'Legajo del chofer' })
  @IsUUID()
  employeeId!: string;

  @FechaCalendario('2026-11-01')
  periodFrom!: string;

  @FechaCalendario('2026-11-30')
  periodTo!: string;
}

export class PayDriverLiquidationDto {
  @ApiProperty({ description: 'Caja de la que sale el pago' })
  @IsUUID()
  cashBoxId!: string;
}

export class UnpayDriverLiquidationDto {
  @ApiProperty({ example: 'Se pagó por la caja equivocada', maxLength: 500 })
  @MotivoObligatorio()
  reason!: string;
}

export class QueryDriverLiquidationDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ enum: LiquidationStatus })
  @IsOptional()
  @IsEnum(LiquidationStatus)
  status?: LiquidationStatus;

  @FechaCalendarioOpcional('2026-11-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-11-30', undefined)
  to?: string;
}

export class DriverLiquidationResponseDto {
  @ApiProperty() liquidationId!: string;
  @ApiProperty({ example: 3 }) number!: number;
  @ApiProperty() employeeId!: string;
  @ApiProperty({ example: 'Juan Pérez' }) employeeName!: string;
  @ApiProperty({ example: '2026-11-01' }) periodFrom!: string;
  @ApiProperty({ example: '2026-11-30' }) periodTo!: string;
  @ApiProperty({ example: 9000 }) gross!: number;
  @ApiProperty({ example: 750, description: 'En positivo' })
  deductions!: number;
  @ApiProperty({ example: 8250 }) net!: number;
  @ApiProperty({ enum: LiquidationStatus }) status!: LiquidationStatus;
  @ApiProperty({ type: Date, nullable: true }) approvedAt!: Date | null;
  @ApiProperty({ type: Date, nullable: true }) paidAt!: Date | null;
  @ApiProperty({ type: Date, nullable: true }) voidedAt!: Date | null;
  @ApiProperty({ type: String, nullable: true }) cashMovementId!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class DriverLiquidationPageDto {
  @ApiProperty({ type: [DriverLiquidationResponseDto] })
  data!: DriverLiquidationResponseDto[];
  @ApiProperty({ example: 6 }) total!: number;
}

export class DriverLiquidationDetailDto extends DriverLiquidationResponseDto {
  @ApiProperty({ type: [CommissionEntryResponseDto] })
  entries!: CommissionEntryResponseDto[];
}
