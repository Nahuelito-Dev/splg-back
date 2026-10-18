import { Injectable } from '@nestjs/common';
import { PersonnelDashboardDto } from './dto/personnel-dashboard.dto';
import { EmployeeService } from '../employee/employee.service';
import { AttendanceService } from '../attendance/attendance.service';
import { LeaveService } from '../leave/leave.service';
import { EmployeeDocumentsService } from '../fleet/employee-documents.service';
import { ExpirationStatus } from '../fleet/domain/expiration-status';
import { diaArgentino } from '../common/utils/dias-argentina';

/**
 * Tablero de personal (CU-194): modelo de lectura que junta cifras de los
 * servicios de `employee`, `attendance`, `leave` y `fleet`. Cuenta; para ver
 * quiénes son, el administrador entra a cada listado.
 */
@Injectable()
export class PersonnelDashboardService {
  constructor(
    private readonly employees: EmployeeService,
    private readonly attendance: AttendanceService,
    private readonly leaves: LeaveService,
    private readonly documents: EmployeeDocumentsService,
  ) {}

  async consultar(distributorId: string): Promise<PersonnelDashboardDto> {
    const hoy = diaArgentino();
    const [porPuesto, presentes, deLicencia, documentos] = await Promise.all([
      this.employees.contarActivosPorPuesto(distributorId),
      this.attendance.contarPresentes(distributorId),
      this.leaves.contarDeLicenciaEn(distributorId, hoy),
      this.documents.contarPorEstadoDeVencimiento(distributorId),
    ]);

    const dto = new PersonnelDashboardDto();
    dto.today = hoy;
    dto.activeByPosition = porPuesto;
    dto.totalActive = porPuesto.reduce((suma, p) => suma + p.count, 0);
    dto.presentToday = presentes;
    dto.onLeaveToday = deLicencia;
    dto.documents = {
      current: documentos[ExpirationStatus.CURRENT],
      dueSoon: documentos[ExpirationStatus.DUE_SOON],
      expired: documentos[ExpirationStatus.EXPIRED],
    };
    return dto;
  }
}
