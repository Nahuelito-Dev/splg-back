import { Employee } from './entities/employee.entity';
import { JobPosition } from './entities/job-position.entity';
import {
  EmployeeListItemDto,
  EmployeeListRowDto,
  EmployeePositionDto,
  EmployeeResponseDto,
} from './dto/employee-response.dto';
import { EmployeeDocumentStatus } from './domain/document-status';
import { JobPositionResponseDto } from './dto/job-position-response.dto';

export class JobPositionMapper {
  static toDto(
    puesto: JobPosition,
    activeEmployees: number,
  ): JobPositionResponseDto {
    const dto = new JobPositionResponseDto();
    dto.positionId = puesto.positionId;
    dto.name = puesto.name;
    dto.category = puesto.category;
    dto.isActive = puesto.isActive;
    dto.activeEmployees = activeEmployees;
    return dto;
  }
}

/** Un empleado con su puesto cargado: lo que el mapper necesita. */
export type EmployeeConPuesto = Employee & { position: JobPosition };

/** Lo que el listado muestra de la documentación de un legajo (CU-180). */
export interface ResumenDeDocumentacion {
  estado: EmployeeDocumentStatus | null;
  proximoVencimiento: string | null;
}

function puestoDto(puesto: JobPosition): EmployeePositionDto {
  const dto = new EmployeePositionDto();
  dto.positionId = puesto.positionId;
  dto.name = puesto.name;
  dto.category = puesto.category;
  return dto;
}

export class EmployeeMapper {
  static toListItem(
    empleado: EmployeeConPuesto,
    documentacion: ResumenDeDocumentacion,
  ): EmployeeListRowDto {
    const dto = EmployeeMapper.llenarFila(new EmployeeListRowDto(), empleado);
    dto.documentStatus = documentacion.estado;
    dto.nextDocumentDueDate = documentacion.proximoVencimiento;
    return dto;
  }

  static toDto(
    empleado: EmployeeConPuesto,
    deliveryId: string | null,
  ): EmployeeResponseDto {
    const dto = EmployeeMapper.llenarFila(new EmployeeResponseDto(), empleado);
    dto.documentType = empleado.documentType;
    dto.documentNumber = empleado.documentNumber;
    dto.cuil = empleado.cuil;
    dto.birthDate = empleado.birthDate;
    dto.addressLine = empleado.addressLine;
    dto.city = empleado.city;
    dto.province = empleado.province;
    dto.postalCode = empleado.postalCode;
    dto.phone = empleado.phone;
    dto.personalEmail = empleado.personalEmail;
    dto.emergencyContactName = empleado.emergencyContactName;
    dto.emergencyContactPhone = empleado.emergencyContactPhone;
    dto.emergencyContactRelationship = empleado.emergencyContactRelationship;
    dto.terminationDate = empleado.terminationDate;
    dto.terminationReason = empleado.terminationReason;
    dto.employmentType = empleado.employmentType;
    dto.bankCbu = empleado.bankCbu;
    dto.notes = empleado.notes;
    dto.userId = empleado.userId;
    dto.deliveryId = deliveryId;
    dto.createdAt = empleado.createdAt;
    dto.updatedAt = empleado.updatedAt;
    return dto;
  }

  private static llenarFila<T extends EmployeeListItemDto>(
    dto: T,
    empleado: EmployeeConPuesto,
  ): T {
    dto.employeeId = empleado.employeeId;
    dto.fileNumber = empleado.fileNumber;
    dto.firstName = empleado.firstName;
    dto.lastName = empleado.lastName;
    dto.position = puestoDto(empleado.position);
    dto.status = empleado.status;
    dto.hireDate = empleado.hireDate;
    dto.hasAccount = empleado.userId !== null;
    dto.photoUrl = empleado.photoSignedUrl ?? null;
    return dto;
  }
}
