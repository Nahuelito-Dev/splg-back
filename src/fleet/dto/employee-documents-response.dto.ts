import { ApiProperty } from '@nestjs/swagger';
import { FleetTaskResponseDto } from './task-response.dto';
import { FleetPlanResponseDto } from './plan-response.dto';

/** CU-187: la documentación de un empleado y qué le falta cargar. */
export class EmployeeDocumentsResponseDto {
  @ApiProperty({ format: 'uuid' }) employeeId!: string;

  @ApiProperty({
    description:
      'Queda inhabilitado para el despacho por la misma regla que aplica el despacho (CU-246): legajo egresado, licencia aprobada que cubre hoy o documentación bloqueante vencida (incluida la licencia de conducir). No mira el vehículo en uso.',
  })
  isLocked!: boolean;

  @ApiProperty({
    type: String,
    isArray: true,
    example: ['Examen psicofísico: venció el 01/03/2026'],
    description: 'Los motivos de la inhabilitación, en castellano',
  })
  lockReasons!: string[];

  @ApiProperty({
    type: FleetTaskResponseDto,
    isArray: true,
    description:
      'Las tareas del empleado, con su estado de vencimiento (incluye la licencia de conducir de un chofer)',
  })
  tasks!: FleetTaskResponseDto[];

  @ApiProperty({
    type: FleetPlanResponseDto,
    isArray: true,
    description:
      'Planes activos que le aplican por la categoría de su puesto y para los que no tiene ninguna tarea abierta',
  })
  missingPlans!: FleetPlanResponseDto[];
}
