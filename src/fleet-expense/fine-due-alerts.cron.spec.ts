import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import {
  EVENTO_NOTIFICAR_ADMIN,
  NotificarAdminEvent,
} from '../common/events/notificar-admin.event';
import { ScheduledTasksSettingsService } from '../distributor/scheduled-tasks-settings.service';
import { FineDueAlertsCron } from './fine-due-alerts.cron';
import { TrafficFine } from './entities/traffic-fine.entity';

// 31/10/2026 11:00 UTC = 08:00 en Argentina
const AHORA = new Date('2026-10-31T11:00:00.000Z');

describe('FineDueAlertsCron (CU-326, F15)', () => {
  let cron: FineDueAlertsCron;
  let getMany: jest.Mock;
  let andWhere: jest.Mock;
  let esLaHora: jest.Mock;
  let emit: jest.Mock;

  const multa = (over: Partial<TrafficFine> = {}) =>
    ({
      fineId: 'm1',
      distributorId: 'd1',
      carId: 'c1',
      actNumber: 'A-1',
      jurisdiction: 'Posadas',
      amount: 85000,
      voluntaryPaymentAmount: null,
      paymentUrl: null,
      dueDate: '2026-11-03',
      car: { carPatent: 'AB123CD' },
      ...over,
    }) as unknown as TrafficFine;

  const avisos = (): NotificarAdminEvent[] =>
    emit.mock.calls.map((c: [string, NotificarAdminEvent]) => c[1]);

  beforeEach(() => {
    getMany = jest.fn().mockResolvedValue([]);
    andWhere = jest.fn().mockReturnThis();
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere,
      orderBy: jest.fn().mockReturnThis(),
      getMany,
    };
    esLaHora = jest.fn().mockResolvedValue(true);
    emit = jest.fn();
    cron = new FineDueAlertsCron(
      {
        createQueryBuilder: jest.fn(() => qb),
      } as unknown as Repository<TrafficFine>,
      {
        esLaHoraDelAvisoDeFlota: esLaHora,
      } as unknown as ScheduledTasksSettingsService,
      { emit } as unknown as EventEmitter2,
    );
  });

  it('sin multas por avisar no emite nada', async () => {
    await cron.avisarMultasPorVencer(AHORA);
    expect(emit).not.toHaveBeenCalled();
  });

  it('busca las pendientes con vencimiento en hasta 5 días contados en hora argentina', async () => {
    await cron.avisarMultasPorVencer(new Date('2026-10-17T12:00:00.000Z'));
    expect(andWhere).toHaveBeenCalledWith('m.due_date <= :limite', {
      limite: '2026-10-22',
    });
  });

  it('no repite las que el correo anterior ya avisó y no recorre el historial: piso de 30 días', async () => {
    await cron.avisarMultasPorVencer(AHORA);
    expect(andWhere).toHaveBeenCalledWith('m.alerted_at IS NULL');
    expect(andWhere).toHaveBeenCalledWith('m.due_date >= :piso', {
      piso: '2026-10-01',
    });
  });

  it('vencida: el texto no ofrece el pago voluntario, que ya no vale', async () => {
    getMany.mockResolvedValue([
      multa({ dueDate: '2026-10-20', voluntaryPaymentAmount: 59500 }),
    ]);
    await cron.avisarMultasPorVencer(AHORA);
    expect(avisos()[0].body).not.toContain('voluntario');
  });

  it('multa por vencer: aviso por la bandeja y por mail, con enlace a la multa y clave por vencimiento', async () => {
    getMany.mockResolvedValue([
      multa({
        voluntaryPaymentAmount: 59500,
        paymentUrl: 'https://pagos.posadas.test/m1',
      }),
    ]);
    await cron.avisarMultasPorVencer(AHORA);

    expect(emit).toHaveBeenCalledWith(
      EVENTO_NOTIFICAR_ADMIN,
      expect.any(NotificarAdminEvent),
    );
    const [aviso] = avisos();
    expect(aviso).toMatchObject({
      distributorId: 'd1',
      kind: 'traffic_fine_due',
      dedupeKey: 'traffic-fine:m1:due:2026-11-03',
      link: { entity: 'traffic-fine', id: 'm1' },
      email: true,
    });
    expect(aviso.title).toContain('AB123CD');
    expect(aviso.body).toContain('A-1');
    expect(aviso.body).toContain('voluntario');
    expect(aviso.body).toContain('03/11/2026');
    expect(aviso.body).toContain('https://pagos.posadas.test/m1');
  });

  it('multa vencida sin pagar: aviso de peligro con su propia clave', async () => {
    getMany.mockResolvedValue([multa({ dueDate: '2026-10-20' })]);
    await cron.avisarMultasPorVencer(AHORA);
    expect(avisos()[0]).toMatchObject({
      kind: 'traffic_fine_overdue',
      dedupeKey: 'traffic-fine:m1:overdue:2026-10-20',
    });
  });

  it('un cambio de vencimiento cambia la clave: la multa vuelve a avisar', async () => {
    getMany.mockResolvedValue([multa({ dueDate: '2026-11-04' })]);
    await cron.avisarMultasPorVencer(AHORA);
    expect(avisos()[0].dedupeKey).toBe('traffic-fine:m1:due:2026-11-04');
  });

  it('respeta la hora del aviso de flota de cada distribuidora y consulta una sola vez por distribuidora', async () => {
    getMany.mockResolvedValue([
      multa(),
      multa({ fineId: 'm2' }),
      multa({ fineId: 'm3', distributorId: 'd2' }),
    ]);
    esLaHora.mockImplementation((d: string) => Promise.resolve(d === 'd1'));

    await cron.avisarMultasPorVencer(AHORA);

    expect(esLaHora).toHaveBeenCalledTimes(2);
    expect(esLaHora).toHaveBeenCalledWith('d1', 8);
    expect(avisos().map((a) => a.dedupeKey)).toEqual([
      'traffic-fine:m1:due:2026-11-03',
      'traffic-fine:m2:due:2026-11-03',
    ]);
  });

  it('no manda correo propio: todo el aviso sale por el evento de la bandeja', () => {
    expect(Object.keys(cron)).not.toContain('emailSender');
  });
});
