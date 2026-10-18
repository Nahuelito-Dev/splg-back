import { ApiProperty } from '@nestjs/swagger';
import { JobPositionCategory } from '../../employee/entities/job-position.entity';

export class ActivePerPositionDto {
  @ApiProperty({ format: 'uuid' }) positionId!: string;
  @ApiProperty({ example: 'Chofer' }) name!: string;
  @ApiProperty({ enum: JobPositionCategory }) category!: JobPositionCategory;
  @ApiProperty({ example: 6 }) count!: number;
}

export class DocumentsByStatusDto {
  @ApiProperty({
    description: 'Vigentes: falta más que la anticipación del plan',
  })
  current!: number;
  @ApiProperty({ description: 'Por vencer: dentro de la ventana de aviso' })
  dueSoon!: number;
  @ApiProperty({ description: 'Vencidas' }) expired!: number;
}

/** Tablero de personal (CU-194): cuenta, no lista. */
export class PersonnelDashboardDto {
  @ApiProperty({
    example: '2026-10-17',
    format: 'date',
    description: 'El día de hoy en Argentina',
  })
  today!: string;
  @ApiProperty({ description: 'Total de empleados activos' })
  totalActive!: number;
  @ApiProperty({ type: ActivePerPositionDto, isArray: true })
  activeByPosition!: ActivePerPositionDto[];
  @ApiProperty({ description: 'Empleados con una jornada abierta' })
  presentToday!: number;
  @ApiProperty({
    description: 'Empleados con una licencia aprobada que cubre el día de hoy',
  })
  onLeaveToday!: number;
  @ApiProperty({ type: DocumentsByStatusDto })
  documents!: DocumentsByStatusDto;
}
