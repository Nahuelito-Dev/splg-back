import { AttendanceOpenAlertCron } from './attendance-open-alert.cron';
import { AttendanceService } from './attendance.service';
import { AdminService } from '../admin/admin.service';
import { EmailSenderPort } from '../email/ports/email-sender.port';
import { EmployeeAttendance } from './entities/employee-attendance.entity';

describe('AttendanceOpenAlertCron', () => {
  let cron: AttendanceOpenAlertCron;
  let attendance: { abiertasAnteriores: jest.Mock };
  let admins: { findAll: jest.Mock };
  let email: { send: jest.Mock };

  const abierta = (over: Record<string, unknown> = {}) =>
    ({
      attendanceId: 'a1',
      distributorId: 'd1',
      employeeId: 'e1',
      checkInAt: new Date('2026-10-16T11:00:00Z'),
      employee: { firstName: 'Ana', lastName: 'Pérez' },
      ...over,
    }) as unknown as EmployeeAttendance;

  beforeEach(() => {
    attendance = { abiertasAnteriores: jest.fn().mockResolvedValue([]) };
    admins = {
      findAll: jest.fn().mockResolvedValue([{ user: { email: 'a@splg.app' } }]),
    };
    email = { send: jest.fn().mockResolvedValue(undefined) };
    cron = new AttendanceOpenAlertCron(
      attendance as unknown as AttendanceService,
      admins as unknown as AdminService,
      email as unknown as EmailSenderPort,
    );
  });

  it('pide todas las abiertas de días anteriores a hoy (día argentino)', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-17T10:00:00Z') }); // 07:00 ART
    await cron.avisarJornadasSinCerrar();
    jest.useRealTimers();
    expect(attendance.abiertasAnteriores).toHaveBeenCalledWith('2026-10-17');
    expect(email.send).not.toHaveBeenCalled();
  });

  it('avisa por correo a los administradores de cada distribuidora, nombrando al empleado', async () => {
    attendance.abiertasAnteriores.mockResolvedValue([
      abierta(),
      abierta({ attendanceId: 'a2', distributorId: 'd2' }),
    ]);

    await cron.avisarJornadasSinCerrar();

    expect(admins.findAll).toHaveBeenCalledWith('d1');
    expect(admins.findAll).toHaveBeenCalledWith('d2');
    expect(email.send).toHaveBeenCalledTimes(2);
    const [[primero]] = email.send.mock.calls as [
      [{ html: string; to: string }],
    ];
    expect(primero.to).toBe('a@splg.app');
    expect(primero.html).toContain('Ana Pérez');
  });

  it('sin administradores con correo no manda nada, y una falla no frena a las demás', async () => {
    attendance.abiertasAnteriores.mockResolvedValue([
      abierta(),
      abierta({ distributorId: 'd2' }),
    ]);
    admins.findAll
      .mockRejectedValueOnce(new Error('caída'))
      .mockResolvedValueOnce([{ user: { email: undefined } }]);

    await cron.avisarJornadasSinCerrar();

    expect(email.send).not.toHaveBeenCalled();
    expect(admins.findAll).toHaveBeenCalledTimes(2);
  });

  it('escapa el nombre en el HTML del correo', async () => {
    attendance.abiertasAnteriores.mockResolvedValue([
      abierta({ employee: { firstName: '<b>Ana', lastName: 'Pé&rez' } }),
    ]);

    await cron.avisarJornadasSinCerrar();

    const [[envio]] = email.send.mock.calls as [[{ html: string }]];
    expect(envio.html).toContain('&lt;b&gt;Ana Pé&amp;rez');
    expect(envio.html).not.toContain('<b>Ana');
  });
});
