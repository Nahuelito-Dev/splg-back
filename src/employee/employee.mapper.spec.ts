import { EmployeeMapper, EmployeeConPuesto } from './employee.mapper';
import { EmployeeDocumentStatus } from './domain/document-status';
import { EmployeeStatus } from './entities/employee.entity';
import { JobPositionCategory } from './entities/job-position.entity';

const empleado = {
  employeeId: 'e1',
  fileNumber: '0001',
  firstName: 'Ana',
  lastName: 'Pérez',
  status: EmployeeStatus.ACTIVE,
  hireDate: '2024-03-01',
  userId: null,
  position: {
    positionId: 'p1',
    name: 'Depósito',
    category: JobPositionCategory.WAREHOUSE,
  },
} as unknown as EmployeeConPuesto;

describe('EmployeeMapper.toListItem (CU-180)', () => {
  it('suma el estado de la documentación y el próximo vencimiento', () => {
    const fila = EmployeeMapper.toListItem(empleado, {
      estado: EmployeeDocumentStatus.DUE_SOON,
      proximoVencimiento: '2027-05-10',
    });
    expect(fila).toMatchObject({
      employeeId: 'e1',
      documentStatus: 'due_soon',
      nextDocumentDueDate: '2027-05-10',
    });
  });

  it('un legajo sin estado sale con null en los dos campos', () => {
    const fila = EmployeeMapper.toListItem(empleado, {
      estado: null,
      proximoVencimiento: null,
    });
    expect(fila.documentStatus).toBeNull();
    expect(fila.nextDocumentDueDate).toBeNull();
  });
});
