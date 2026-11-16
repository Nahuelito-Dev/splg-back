import { ApiProperty } from '@nestjs/swagger';
import { CylinderState } from '../entities/cylinder.entity';
import { CylinderInspectionResult } from '../entities/cylinder-inspection.entity';
import { EstadoDeVigencia } from '../domain/cylinder-vigencia';

export class CylinderInspectionResponseDto {
  @ApiProperty({ format: 'uuid' }) inspectionId!: string;
  @ApiProperty({ format: 'uuid' }) cylinderId!: string;
  @ApiProperty({ type: String, format: 'date-time' }) inspectedAt!: Date;
  @ApiProperty({ enum: CylinderInspectionResult })
  result!: CylinderInspectionResult;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  nextDueAt!: Date | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
}

/** Un envase en el listado de vencimientos. */
export class CylinderVencimientoDto {
  @ApiProperty({ format: 'uuid' }) cylinderId!: string;
  @ApiProperty({ example: 'SN-000123' }) serial!: string;
  @ApiProperty({ enum: CylinderState }) state!: CylinderState;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Garrafa 10kg',
    description: 'Tipo de producto del envase (null si no tiene uno asignado)',
  })
  productType!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastInspectionAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt!: Date | null;
  @ApiProperty({ enum: EstadoDeVigencia }) status!: EstadoDeVigencia;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Días que faltan; negativo si ya venció; null sin vencimiento.',
  })
  daysRemaining!: number | null;
}

export class CylinderVigenciaResponseDto extends CylinderVencimientoDto {
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  manufacturedAt!: Date | null;
  @ApiProperty({
    description:
      'Vencido y todavía en poder de un cliente o en reparto: hay que ' +
      'retirarlo cuando vuelva (no se lo saca de circulación antes).',
  })
  withdrawalPending!: boolean;
  @ApiProperty({
    type: CylinderInspectionResponseDto,
    isArray: true,
    description:
      'Historial de revisiones, de la más reciente a la más antigua.',
  })
  inspections!: CylinderInspectionResponseDto[];
}

export class TotalesDeVencimientosDto {
  @ApiProperty() expired!: number;
  @ApiProperty() expiring!: number;
  @ApiProperty() unverified!: number;
}

export class ExpiringCylindersResponseDto {
  @ApiProperty({ example: 30 }) windowDays!: number;
  @ApiProperty({
    type: TotalesDeVencimientosDto,
    description: 'Total de cada grupo, sin paginar.',
  })
  totals!: TotalesDeVencimientosDto;
  @ApiProperty({
    type: CylinderVencimientoDto,
    isArray: true,
    description:
      'Ya vencidos (no se pueden despachar), del más atrasado al menos.',
  })
  expired!: CylinderVencimientoDto[];
  @ApiProperty({
    type: CylinderVencimientoDto,
    isArray: true,
    description: 'Vencen dentro de la ventana, del más urgente al menos.',
  })
  expiring!: CylinderVencimientoDto[];
  @ApiProperty({
    type: CylinderVencimientoDto,
    isArray: true,
    description: 'Sin revisión registrada: no hay fecha con la cual comparar.',
  })
  unverified!: CylinderVencimientoDto[];
}
