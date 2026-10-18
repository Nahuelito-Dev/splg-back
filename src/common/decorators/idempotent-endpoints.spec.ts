import { IDEMPOTENT_KEY } from './idempotent.decorator';
import { IncidentController } from '../../incident/incident.controller';
import { ClaimsController } from '../../claims/claims.controller';
import { AttachmentController } from '../../attachment/attachment.controller';
import { FleetTaskController } from '../../fleet/fleet-task.controller';
import { UserAddressController } from '../../user-address/user-address.controller';
import { CylinderController } from '../../cylinder/cylinder.controller';
import { EmployeeController } from '../../employee/employee.controller';
import { OrderController } from '../../order/order.controller';
import { LeaveController } from '../../leave/leave.controller';
import { AttendanceController } from '../../attendance/attendance.controller';

type Clase = { name: string; prototype: object };

/** Las escrituras con efecto no repetible que tienen que aceptar `Idempotency-Key`. */
const IDEMPOTENTES: Array<[Clase, string[]]> = [
  [IncidentController, ['create']],
  [ClaimsController, ['create', 'uploadPhoto']],
  [AttachmentController, ['upload']],
  [FleetTaskController, ['create', 'uploadAttachment']],
  [UserAddressController, ['create']],
  [CylinderController, ['assign']],
  [EmployeeController, ['terminateEmployee', 'reinstate']],
  [LeaveController, ['create']],
  [AttendanceController, ['register', 'checkIn', 'checkOut']],
  [
    OrderController,
    [
      'create',
      'updateStatus',
      'cancel',
      'confirmDelivery',
      'confirmCashReceived',
      'resolveUnpaid',
      'confirmDeposit',
      'assignDelivery',
      'changeAddress',
      'setReceiver',
    ],
  ],
];

describe('escrituras con Idempotency-Key', () => {
  it.each(
    IDEMPOTENTES.flatMap(([clase, metodos]) =>
      metodos.map((m) => [`${clase.name}.${m}`, clase, m] as const),
    ),
  )('%s es @Idempotent()', (_nombre, clase, metodo) => {
    const handler = (clase.prototype as Record<string, object>)[metodo];
    expect(Reflect.getMetadata(IDEMPOTENT_KEY, handler)).toBe(true);
  });
});
