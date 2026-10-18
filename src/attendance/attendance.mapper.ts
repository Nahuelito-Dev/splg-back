import { EmployeeAttendance } from './entities/employee-attendance.entity';
import { Employee } from '../employee/entities/employee.entity';
import { AttendanceResponseDto } from './dto/attendance-response.dto';
import { duracionEnMinutos } from './domain/attendance-rules';

/** Una jornada con el legajo cargado: lo que el mapper necesita. */
export type JornadaConLegajo = EmployeeAttendance & { employee: Employee };

export class AttendanceMapper {
  static toDto(jornada: JornadaConLegajo): AttendanceResponseDto {
    const dto = new AttendanceResponseDto();
    dto.attendanceId = jornada.attendanceId;
    dto.employeeId = jornada.employeeId;
    dto.employeeName = `${jornada.employee.firstName} ${jornada.employee.lastName}`;
    dto.employeeFileNumber = jornada.employee.fileNumber;
    dto.workDate = jornada.workDate;
    dto.checkInAt = jornada.checkInAt;
    dto.checkOutAt = jornada.checkOutAt;
    dto.isOpen = jornada.checkOutAt === null;
    dto.durationMinutes = duracionEnMinutos(
      jornada.checkInAt,
      jornada.checkOutAt,
    );
    dto.source = jornada.source;
    dto.recordedByUserId = jornada.recordedByUserId;
    dto.notes = jornada.notes;
    return dto;
  }
}
