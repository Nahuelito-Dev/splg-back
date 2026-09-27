import { Repository } from 'typeorm';
import { FleetAlertsCron } from './fleet-alerts.cron';
import { MaintenanceTask } from './entities/maintenance-task.entity';
import { AdminService } from '../admin/admin.service';
import { EmailSenderPort } from '../email/ports/email-sender.port';

describe('FleetAlertsCron', () => {
  let cron: FleetAlertsCron;
  let getMany: jest.Mock;
  let update: jest.Mock;
  let adminService: { findAll: jest.Mock };
  let emailSender: { send: jest.Mock };

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

    cron = new FleetAlertsCron(
      tasks as unknown as Repository<MaintenanceTask>,
      adminService as unknown as AdminService,
      emailSender as unknown as EmailSenderPort,
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
      { user: { email: 'admin@jenygas.com' } },
    ]);

    await cron.avisarVencimientosPendientes();

    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@jenygas.com' }),
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
      { user: { email: 'admin@jenygas.com' } },
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
});
