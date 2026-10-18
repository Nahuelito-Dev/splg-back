import { Repository } from 'typeorm';
import { FleetAlertsCron } from './fleet-alerts.cron';
import { MaintenanceTask } from './entities/maintenance-task.entity';
import { AdminService } from '../admin/admin.service';
import { EmailSenderPort } from '../email/ports/email-sender.port';
import { EmployeeService } from '../employee/employee.service';
import { EmployeeDocumentsService } from './employee-documents.service';

describe('FleetAlertsCron', () => {
  let cron: FleetAlertsCron;
  let getMany: jest.Mock;
  let update: jest.Mock;
  let adminService: { findAll: jest.Mock };
  let emailSender: { send: jest.Mock };
  let esLaHora: jest.Mock;
  let employees: { distribuidorasConChoferesActivos: jest.Mock };
  let documents: { faltantesBloqueantesDeChoferes: jest.Mock };

  const tareaPorVencer = (over: Partial<MaintenanceTask> = {}) =>
    ({
      taskId: 't1',
      distributorId: 'd1',
      dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // en 5 días
      alertedAt: null,
      car: { carId: 'c1', carPatent: 'AB123CD' },
      delivery: null,
      plan: { name: 'VTV', leadTimeDays: 30 },
      ...over,
    }) as unknown as MaintenanceTask;

  beforeEach(() => {
    getMany = jest.fn();
    update = jest.fn().mockResolvedValue(undefined);
    const qb = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany,
    };
    const tasks = { createQueryBuilder: jest.fn().mockReturnValue(qb), update };
    adminService = { findAll: jest.fn().mockResolvedValue([]) };
    emailSender = { send: jest.fn().mockResolvedValue(undefined) };

    esLaHora = jest.fn().mockResolvedValue(true);
    employees = {
      distribuidorasConChoferesActivos: jest.fn().mockResolvedValue([]),
    };
    documents = {
      faltantesBloqueantesDeChoferes: jest.fn().mockResolvedValue([]),
    };
    cron = new FleetAlertsCron(
      tasks as unknown as Repository<MaintenanceTask>,
      adminService as unknown as AdminService,
      emailSender as unknown as EmailSenderPort,
      {
        esLaHoraDelAvisoDeFlota: esLaHora,
      } as unknown as import('../distributor/scheduled-tasks-settings.service').ScheduledTasksSettingsService,
      employees as unknown as EmployeeService,
      documents as unknown as EmployeeDocumentsService,
    );
  });

  it('sin tareas por avisar, no hace nada', async () => {
    getMany.mockResolvedValue([]);
    await cron.avisarVencimientosPendientes();
    expect(adminService.findAll).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('avisa a los admins con email y marca alertedAt', async () => {
    getMany.mockResolvedValue([tareaPorVencer()]);
    adminService.findAll.mockResolvedValue([
      { user: { email: 'admin@demo.splg.app' } },
    ]);

    await cron.avisarVencimientosPendientes();

    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@demo.splg.app' }),
    );
    const alertedAtMatcher: unknown = expect.any(Date);
    expect(update).toHaveBeenCalledWith(['t1'], {
      alertedAt: alertedAtMatcher,
    });
  });

  it('sin admins con email, igual marca alertedAt (no hay a quién avisarle)', async () => {
    getMany.mockResolvedValue([tareaPorVencer()]);
    adminService.findAll.mockResolvedValue([{ user: { email: undefined } }]);

    await cron.avisarVencimientosPendientes();

    expect(emailSender.send).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
  });

  it('si falla el envío, NO marca alertedAt (se reintenta al día siguiente)', async () => {
    getMany.mockResolvedValue([tareaPorVencer()]);
    adminService.findAll.mockResolvedValue([
      { user: { email: 'admin@demo.splg.app' } },
    ]);
    emailSender.send.mockRejectedValue(new Error('smtp caído'));

    await cron.avisarVencimientosPendientes();

    expect(update).not.toHaveBeenCalled();
  });

  it('una tarea todavía vigente (dentro del lead time) no se avisa', async () => {
    getMany.mockResolvedValue([
      tareaPorVencer({
        dueAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // en 90 días
      }),
    ]);

    await cron.avisarVencimientosPendientes();

    expect(adminService.findAll).not.toHaveBeenCalled();
  });

  it('agrupa por distribuidora: una corrida por cada una', async () => {
    getMany.mockResolvedValue([
      tareaPorVencer({ taskId: 't1', distributorId: 'd1' }),
      tareaPorVencer({ taskId: 't2', distributorId: 'd2' }),
    ]);
    adminService.findAll.mockResolvedValue([]);

    await cron.avisarVencimientosPendientes();

    expect(adminService.findAll).toHaveBeenCalledWith('d1');
    expect(adminService.findAll).toHaveBeenCalledWith('d2');
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('CU-173: avisa sólo a la distribuidora cuya hora es la actual', async () => {
    getMany.mockResolvedValue([
      tareaPorVencer({ taskId: 't1', distributorId: 'd1' }),
      tareaPorVencer({ taskId: 't2', distributorId: 'd2' }),
    ]);
    adminService.findAll.mockResolvedValue([]);
    esLaHora.mockImplementation((id: string) => Promise.resolve(id === 'd2'));
    // 14:30 UTC = 11:30 en Argentina (UTC-3).
    jest.useFakeTimers({ now: new Date('2026-10-15T14:30:00Z') });

    await cron.avisarVencimientosPendientes();
    jest.useRealTimers();

    expect(esLaHora).toHaveBeenCalledWith('d1', 11);
    expect(adminService.findAll).not.toHaveBeenCalledWith('d1');
    expect(adminService.findAll).toHaveBeenCalledWith('d2');
    expect(update).toHaveBeenCalledTimes(1);
  });

  describe('personal (CU-188)', () => {
    const tareaDeEmpleado = (over: Partial<MaintenanceTask> = {}) =>
      tareaPorVencer({
        taskId: 'te1',
        car: null,
        carId: null,
        employee: { firstName: 'Ana', lastName: 'Pérez' },
        plan: { name: 'Examen psicofísico', leadTimeDays: 30 },
        ...over,
      } as unknown as Partial<MaintenanceTask>);

    const faltante = {
      empleado: { firstName: 'Beto', lastName: 'Gómez' },
      planes: [{ name: 'Curso de transporte de mercancías peligrosas (GLP)' }],
    };

    const admin = [{ user: { email: 'admin@demo.splg.app' } }];

    it('nombra al empleado en el correo y marca la tarea como avisada', async () => {
      getMany.mockResolvedValue([tareaDeEmpleado()]);
      adminService.findAll.mockResolvedValue(admin);

      await cron.avisarVencimientosPendientes();

      const [[envio]] = emailSender.send.mock.calls as [[{ html: string }]];
      expect(envio.html).toContain('Empleado Ana Pérez');
      expect(envio.html).toContain('Examen psicofísico');
      expect(update).toHaveBeenCalledWith(['te1'], {
        alertedAt: expect.any(Date) as unknown,
      });
    });

    it('los documentos faltantes entran en el correo y NO se marcan: no hay tarea que marcar', async () => {
      getMany.mockResolvedValue([]);
      employees.distribuidorasConChoferesActivos.mockResolvedValue(['d1']);
      documents.faltantesBloqueantesDeChoferes.mockResolvedValue([faltante]);
      adminService.findAll.mockResolvedValue(admin);

      await cron.avisarVencimientosPendientes();

      const [[envio]] = emailSender.send.mock.calls as [
        [{ html: string; subject: string }],
      ];
      expect(envio.html).toContain('Beto Gómez');
      expect(envio.html).toContain('Curso de transporte');
      expect(envio.subject).toContain('1 chofer(es) con documentos sin cargar');
      expect(update).not.toHaveBeenCalled();
    });

    it('vencimientos y faltantes van en un único correo por administrador', async () => {
      getMany.mockResolvedValue([tareaDeEmpleado()]);
      employees.distribuidorasConChoferesActivos.mockResolvedValue(['d1']);
      documents.faltantesBloqueantesDeChoferes.mockResolvedValue([faltante]);
      adminService.findAll.mockResolvedValue(admin);

      await cron.avisarVencimientosPendientes();

      expect(emailSender.send).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('si falla el envío no marca las tareas y el faltante se repetirá mañana', async () => {
      getMany.mockResolvedValue([tareaDeEmpleado()]);
      documents.faltantesBloqueantesDeChoferes.mockResolvedValue([faltante]);
      employees.distribuidorasConChoferesActivos.mockResolvedValue(['d1']);
      adminService.findAll.mockResolvedValue(admin);
      emailSender.send.mockRejectedValue(new Error('smtp caído'));

      await cron.avisarVencimientosPendientes();

      expect(update).not.toHaveBeenCalled();
    });

    it('sin nada que avisar ni faltantes en una distribuidora con choferes, no manda nada', async () => {
      getMany.mockResolvedValue([]);
      employees.distribuidorasConChoferesActivos.mockResolvedValue(['d1']);

      await cron.avisarVencimientosPendientes();

      expect(adminService.findAll).not.toHaveBeenCalled();
      expect(emailSender.send).not.toHaveBeenCalled();
    });

    it('sólo calcula los faltantes de las distribuidoras a las que les toca la hora', async () => {
      getMany.mockResolvedValue([]);
      employees.distribuidorasConChoferesActivos.mockResolvedValue([
        'd1',
        'd2',
      ]);
      esLaHora.mockImplementation((id: string) => Promise.resolve(id === 'd2'));

      await cron.avisarVencimientosPendientes();

      expect(documents.faltantesBloqueantesDeChoferes).toHaveBeenCalledTimes(1);
      expect(documents.faltantesBloqueantesDeChoferes).toHaveBeenCalledWith(
        'd2',
      );
    });
  });
});
