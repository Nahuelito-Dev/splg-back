import { EmployeeLeave } from './entities/employee-leave.entity';
import { Employee } from '../employee/entities/employee.entity';
import { LeaveResponseDto } from './dto/leave-response.dto';

/** Una licencia con el legajo cargado: lo que el mapper necesita. */
export type LicenciaConLegajo = EmployeeLeave & { employee: Employee };

export class LeaveMapper {
  static toDto(licencia: LicenciaConLegajo): LeaveResponseDto {
    const dto = new LeaveResponseDto();
    dto.leaveId = licencia.leaveId;
    dto.employeeId = licencia.employeeId;
    dto.employeeName = `${licencia.employee.firstName} ${licencia.employee.lastName}`;
    dto.employeeFileNumber = licencia.employee.fileNumber;
    dto.type = licencia.type;
    dto.startDate = licencia.startDate;
    dto.endDate = licencia.endDate;
    dto.days = licencia.days;
    dto.status = licencia.status;
    dto.reason = licencia.reason;
    dto.rejectionReason = licencia.rejectionReason;
    dto.requestedByUserId = licencia.requestedByUserId;
    dto.decidedByUserId = licencia.decidedByUserId;
    dto.decidedAt = licencia.decidedAt;
    dto.createdAt = licencia.createdAt;
    return dto;
  }
}
