import { ApiProperty } from '@nestjs/swagger';
import { JobPositionCategory } from '../entities/job-position.entity';

export class JobPositionResponseDto {
  @ApiProperty({ format: 'uuid' })
  positionId!: string;

  @ApiProperty({ example: 'Chofer' })
  name!: string;

  @ApiProperty({ enum: JobPositionCategory })
  category!: JobPositionCategory;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({
    example: 3,
    description: 'Empleados activos (no egresados) que ocupan el puesto',
  })
  activeEmployees!: number;
}
