import { ApiProperty } from '@nestjs/swagger';
import {
  EmployeeDocumentType,
  EmployeeStatus,
  EmployeeTerminationReason,
  EmploymentType,
} from '../entities/employee.entity';
import { JobPositionCategory } from '../entities/job-position.entity';

export class EmployeePositionDto {
  @ApiProperty({ format: 'uuid' })
  positionId!: string;

  @ApiProperty({ example: 'Chofer' })
  name!: string;

  @ApiProperty({ enum: JobPositionCategory })
  category!: JobPositionCategory;
}

/** Una fila del listado: sin documento, CUIL, domicilio ni contacto de emergencia (Ley 25.326). */
export class EmployeeListItemDto {
  @ApiProperty({ format: 'uuid' })
  employeeId!: string;

  @ApiProperty({ example: '0042' })
  fileNumber!: string;

  @ApiProperty({ example: 'Ana' })
  firstName!: string;

  @ApiProperty({ example: 'Pérez' })
  lastName!: string;

  @ApiProperty({ type: EmployeePositionDto })
  position!: EmployeePositionDto;

  @ApiProperty({ enum: EmployeeStatus })
  status!: EmployeeStatus;

  @ApiProperty({ example: '2026-03-01', format: 'date' })
  hireDate!: string;

  @ApiProperty({ description: 'Tiene cuenta de acceso' })
  hasAccount!: boolean;
}

/** El legajo completo (CU-179): lo único que expone los datos personales. */
export class EmployeeResponseDto extends EmployeeListItemDto {
  @ApiProperty({ enum: EmployeeDocumentType })
  documentType!: EmployeeDocumentType;

  @ApiProperty({ example: '30123456' })
  documentNumber!: string;

  @ApiProperty({ type: String, nullable: true, example: '20123456786' })
  cuil!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date' })
  birthDate!: string | null;

  @ApiProperty({ type: String, nullable: true })
  addressLine!: string | null;

  @ApiProperty({ type: String, nullable: true })
  city!: string | null;

  @ApiProperty({ type: String, nullable: true })
  province!: string | null;

  @ApiProperty({ type: String, nullable: true })
  postalCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  personalEmail!: string | null;

  @ApiProperty({ type: String, nullable: true })
  emergencyContactName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  emergencyContactPhone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  emergencyContactRelationship!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date' })
  terminationDate!: string | null;

  @ApiProperty({
    enum: EmployeeTerminationReason,
    nullable: true,
    type: String,
  })
  terminationReason!: EmployeeTerminationReason | null;

  @ApiProperty({ enum: EmploymentType })
  employmentType!: EmploymentType;

  @ApiProperty({ type: String, nullable: true })
  bankCbu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Usuario de la cuenta de acceso, si tiene',
  })
  userId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Perfil de reparto, si la cuenta es de un chofer',
  })
  deliveryId!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class EmployeePageDto {
  @ApiProperty({ type: EmployeeListItemDto, isArray: true })
  data!: EmployeeListItemDto[];

  @ApiProperty({ example: 42 })
  total!: number;
}
