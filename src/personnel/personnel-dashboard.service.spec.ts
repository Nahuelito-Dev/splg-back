import { PersonnelDashboardService } from './personnel-dashboard.service';
import { EmployeeService } from '../employee/employee.service';
import { AttendanceService } from '../attendance/attendance.service';
import { LeaveService } from '../leave/leave.service';
import { EmployeeDocumentsService } from '../fleet/employee-documents.service';
import { JobPositionCategory } from '../employee/entities/job-position.entity';
import { diaArgentino } from '../common/utils/dias-argentina';

describe('PersonnelDashboardService (CU-194)', () => {
  let service: PersonnelDashboardService;
  let employees: { contarActivosPorPuesto: jest.Mock };
  let attendance: { contarPresentes: jest.Mock };
  let leaves: { contarDeLicenciaEn: jest.Mock };
  let documents: { contarPorEstadoDeVencimiento: jest.Mock };

  beforeEach(() => {
    employees = { contarActivosPorPuesto: jest.fn().mockResolvedValue([]) };
    attendance = { contarPresentes: jest.fn().mockResolvedValue(0) };
    leaves = { contarDeLicenciaEn: jest.fn().mockResolvedValue(0) };
    documents = {
      contarPorEstadoDeVencimiento: jest
        .fn()
        .mockResolvedValue({ current: 0, due_soon: 0, expired: 0 }),
    };
    service = new PersonnelDashboardService(
      employees as unknown as EmployeeService,
      attendance as unknown as AttendanceService,
      leaves as unknown as LeaveService,
      documents as unknown as EmployeeDocumentsService,
    );
  });

  it('una distribuidora sin empleados muestra todo en cero', async () => {
    const res = await service.consultar('d1');
    expect(res).toMatchObject({
      today: diaArgentino(),
      totalActive: 0,
      activeByPosition: [],
      presentToday: 0,
      onLeaveToday: 0,
      documents: { current: 0, dueSoon: 0, expired: 0 },
    });
  });

  it('junta las cuatro cifras de la distribuidora y la licencia se mide con el día argentino', async () => {
    employees.contarActivosPorPuesto.mockResolvedValue([
      {
        positionId: 'p1',
        name: 'Chofer',
        category: JobPositionCategory.DRIVER,
        count: 6,
      },
      {
        positionId: 'p2',
        name: 'Depósito',
        category: JobPositionCategory.WAREHOUSE,
        count: 2,
      },
    ]);
    attendance.contarPresentes.mockResolvedValue(5);
    leaves.contarDeLicenciaEn.mockResolvedValue(1);
    documents.contarPorEstadoDeVencimiento.mockResolvedValue({
      current: 10,
      due_soon: 3,
      expired: 2,
    });

    const res = await service.consultar('d1');

    expect(res.totalActive).toBe(8);
    expect(res.presentToday).toBe(5);
    expect(res.onLeaveToday).toBe(1);
    expect(res.documents).toEqual({ current: 10, dueSoon: 3, expired: 2 });
    expect(attendance.contarPresentes).toHaveBeenCalledWith('d1');
    expect(leaves.contarDeLicenciaEn).toHaveBeenCalledWith(
      'd1',
      diaArgentino(),
    );
    expect(documents.contarPorEstadoDeVencimiento).toHaveBeenCalledWith('d1');
  });
});
