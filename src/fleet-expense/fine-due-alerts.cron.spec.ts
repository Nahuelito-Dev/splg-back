import { Repository } from 'typeorm';
import { AdminService } from '../admin/admin.service';
import { EmailSenderPort } from '../email/ports/email-sender.port';
import { FineDueAlertsCron } from './fine-due-alerts.cron';
import { TrafficFine } from './entities/traffic-fine.entity';

describe('FineDueAlertsCron (CU-326)', () => {
  let cron: FineDueAlertsCron;
  let getMany: jest.Mock;
  let update: jest.Mock;
  let andWhere: jest.Mock;
  let adminService: { findAll: jest.Mock };
  let emailSender: { send: jest.Mock };

  const multa = (over: Partial<TrafficFine> = {}) =>
    ({
      fineId: 'm1',
      distributorId: 'd1',
      actNumber: 'A-1',
      jurisdiction: 'Posadas',
      amount: 85000,
      dueDate: '2026-10-20',
      car: { carPatent: 'AB123CD' },
      ...over,
    }) as unknown as TrafficFine;

  beforeEach(() => {
    getMany = jest.fn().mockResolvedValue([]);
    update = jest.fn().mockResolvedValue(undefined);
    andWhere = jest.fn().mockReturnThis();
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere,
      orderBy: jest.fn().mockReturnThis(),
      getMany,
    };
    const fines = { createQueryBuilder: jest.fn(() => qb), update };
    adminService = {
      findAll: jest.fn().mockResolvedValue([{ user: { email: 'a@splg.app' } }]),
    };
    emailSender = { send: jest.fn().mockResolvedValue(undefined) };
    cron = new FineDueAlertsCron(
      fines as unknown as Repository<TrafficFine>,
      adminService as unknown as AdminService,
      emailSender as unknown as EmailSenderPort,
    );
  });

  it('sin multas por avisar no envía ni marca nada', async () => {
    await cron.avisarMultasPorVencer();
    expect(emailSender.send).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('busca las pendientes con vencimiento en hasta 7 días contados en hora argentina', async () => {
    await cron.avisarMultasPorVencer(new Date('2026-10-17T12:00:00.000Z'));
    expect(andWhere).toHaveBeenCalledWith('m.due_date <= :limite', {
      limite: '2026-10-24',
    });
  });

  it('avisa a los administradores de cada distribuidora y marca las multas', async () => {
    getMany.mockResolvedValue([
      multa(),
      multa({ fineId: 'm2' }),
      multa({ fineId: 'm3', distributorId: 'd2' }),
    ]);
    adminService.findAll.mockImplementation((d: string) =>
      Promise.resolve([{ user: { email: `${d}@splg.app` } }]),
    );

    await cron.avisarMultasPorVencer();

    expect(emailSender.send).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith(['m1', 'm2'], {
      alertedAt: expect.any(Date) as Date,
    });
    expect(update).toHaveBeenCalledWith(['m3'], {
      alertedAt: expect.any(Date) as Date,
    });
  });

  it('si falla el envío no marca las multas de esa distribuidora', async () => {
    getMany.mockResolvedValue([multa()]);
    emailSender.send.mockRejectedValue(new Error('smtp caído'));

    await cron.avisarMultasPorVencer();

    expect(update).not.toHaveBeenCalled();
  });

  it('sin administradores con correo las marca igual: no hay a quién avisar dos veces', async () => {
    getMany.mockResolvedValue([multa()]);
    adminService.findAll.mockResolvedValue([{ user: null }]);

    await cron.avisarMultasPorVencer();

    expect(emailSender.send).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });
});
