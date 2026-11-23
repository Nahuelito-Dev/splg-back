import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import {
  EVENTO_NOTIFICAR_ADMIN,
  NotificarAdminEvent,
} from '../../common/events/notificar-admin.event';
import { ScheduledTasksSettingsService } from '../../distributor/scheduled-tasks-settings.service';
import {
  InstallmentApprovalStatus,
  InstallmentStatus,
} from '../domain/insurance.enums';
import { InsurancePolicyService } from './insurance-policy.service';
import { InsuranceInstallment } from '../entities/insurance-installment.entity';
import { InsurancePolicy } from '../entities/insurance-policy.entity';
import { InsuranceAlertsCron } from './insurance-alerts.cron';

// 31/10/2026 11:00 UTC = 08:00 en Argentina
const AHORA = new Date('2026-10-31T11:00:00.000Z');

function cuota(over: Partial<InsuranceInstallment> = {}): InsuranceInstallment {
  return {
    installmentId: 'q1',
    distributorId: 'd1',
    policyId: 'p1',
    number: 5,
    total: 6,
    dueDate: '2026-11-03',
    graceUntil: '2026-11-08',
    amount: 29958,
    status: InstallmentStatus.PENDING,
    approvalStatus: InstallmentApprovalStatus.NONE,
    approvalRequestedAt: null,
    policy: {
      policyId: 'p1',
      carId: 'c1',
      car: { carPatent: 'OVQ621' },
      insurer: {
        name: 'Seguros Rivadavia',
        paymentUrl: 'https://pagos.rivadavia.test/cuotas',
      },
    },
    ...over,
  } as unknown as InsuranceInstallment;
}

function poliza(over: Partial<InsurancePolicy> = {}): InsurancePolicy {
  return {
    policyId: 'p1',
    distributorId: 'd1',
    carId: 'c1',
    policyNumber: '67/02/192143',
    validTo: '2026-11-20',
    car: { carPatent: 'OVQ621' },
    insurer: { name: 'Seguros Rivadavia' },
    ...over,
  } as unknown as InsurancePolicy;
}

describe('InsuranceAlertsCron', () => {
  let cron: InsuranceAlertsCron;
  let emit: jest.Mock;
  let cuotas: InsuranceInstallment[];
  let polizas: InsurancePolicy[];
  let esLaHora: jest.Mock;
  let filtros: string[];
  let conBajas: number;
  let completarPendientes: jest.Mock;
  let pendientes: InsurancePolicy[];
  let update: jest.Mock;

  const qb = <T>(filas: () => T[]) => {
    const b: Record<string, jest.Mock> = {};
    b.withDeleted = jest.fn(() => {
      conBajas += 1;
      return b;
    });
    for (const metodo of [
      'innerJoinAndSelect',
      'leftJoinAndSelect',
      'orderBy',
    ]) {
      b[metodo] = jest.fn(() => b);
    }
    for (const metodo of ['where', 'andWhere']) {
      b[metodo] = jest.fn((condicion: string) => {
        filtros.push(condicion);
        return b;
      });
    }
    b.getMany = jest.fn(() => Promise.resolve(filas()));
    return b;
  };

  beforeEach(() => {
    cuotas = [];
    polizas = [];
    filtros = [];
    conBajas = 0;
    emit = jest.fn();
    completarPendientes = jest.fn().mockResolvedValue(1);
    pendientes = [];
    update = jest.fn().mockResolvedValue({ affected: 1 });
    esLaHora = jest.fn().mockResolvedValue(true);
    cron = new InsuranceAlertsCron(
      {
        createQueryBuilder: () => qb(() => cuotas),
        update,
      } as unknown as Repository<InsuranceInstallment>,
      {
        // la consulta de pendientes es la única que no hace withDeleted
        createQueryBuilder: () => {
          const b: Record<string, jest.Mock> = qb(() =>
            b.withDeleted.mock.calls.length > 0 ? polizas : pendientes,
          );
          return b;
        },
      } as unknown as Repository<InsurancePolicy>,
      {
        esLaHoraDelAvisoDeFlota: esLaHora,
      } as unknown as ScheduledTasksSettingsService,
      { emit } as unknown as EventEmitter2,
      { completarPendientes } as unknown as InsurancePolicyService,
    );
  });

  const avisos = (): NotificarAdminEvent[] =>
    emit.mock.calls.map((c: [string, NotificarAdminEvent]) => c[1]);

  it('cuota que vence en 5 días o menos: aviso con aseguradora, vehículo, importe, vencimiento y enlace de pago, por la bandeja y por mail', async () => {
    cuotas = [cuota()];
    await cron.avisar(AHORA);

    expect(emit).toHaveBeenCalledWith(
      EVENTO_NOTIFICAR_ADMIN,
      expect.any(NotificarAdminEvent),
    );
    const [aviso] = avisos();
    expect(aviso).toMatchObject({
      distributorId: 'd1',
      kind: 'insurance_installment_due',
      dedupeKey: 'insurance-installment:q1:due:approval:2026-11-03',
      // El aviso a 5 días es «¿Aprobar pago?»: apunta a la cuota para aprobarla desde la bandeja.
      link: { entity: 'insurance-installment', id: 'q1' },
      email: true,
    });
    expect(aviso.title).toContain('OVQ621');
    expect(aviso.body).toContain('¿Aprobar el pago?');
    expect(aviso.body).toContain('Seguros Rivadavia');
    expect(aviso.body).toContain('OVQ621');
    expect(aviso.body).toContain('5/6');
    expect(aviso.body).toContain('29.958,00');
    expect(aviso.body).toContain('03/11/2026');
    expect(aviso.body).toContain('https://pagos.rivadavia.test/cuotas');
  });

  describe('aprobación del pago', () => {
    it('la cuota pendiente que avisa queda pendiente de aprobación, con el WHERE que no pisa una aprobación', async () => {
      cuotas = [cuota()];
      await cron.avisar(AHORA);

      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith(
        {
          installmentId: 'q1',
          status: InstallmentStatus.PENDING,
          approvalStatus: InstallmentApprovalStatus.NONE,
        },
        {
          approvalStatus: InstallmentApprovalStatus.AWAITING,
          approvalRequestedAt: AHORA,
        },
      );
    });

    it('una cuota que ya espera la aprobación no se vuelve a pedir y el aviso sigue apuntando a ella', async () => {
      cuotas = [
        cuota({
          approvalStatus: InstallmentApprovalStatus.AWAITING,
          approvalRequestedAt: new Date('2026-10-30T11:00:00Z'),
        }),
      ];
      await cron.avisar(AHORA);
      expect(update).not.toHaveBeenCalled();
      expect(avisos()[0].link).toEqual({
        entity: 'insurance-installment',
        id: 'q1',
      });
    });

    it('la clave del aviso no cambia al aprobar: no se vuelve a avisar la misma cuota', async () => {
      cuotas = [cuota()];
      await cron.avisar(AHORA);
      const antes = avisos()[0].dedupeKey;
      emit.mockClear();
      cuotas = [cuota({ approvalStatus: InstallmentApprovalStatus.APPROVED })];
      await cron.avisar(AHORA);
      expect(avisos()[0].dedupeKey).toBe(antes);
    });

    it('una cuota ya vencida no pasa a pendiente de aprobación (sin ola de pedidos); su aviso es el de vencida', async () => {
      cuotas = [cuota({ dueDate: '2026-10-22', graceUntil: '2026-10-27' })];
      await cron.avisar(AHORA);
      expect(update).not.toHaveBeenCalled();
      expect(avisos()[0]).toMatchObject({
        kind: 'insurance_installment_overdue',
        link: { entity: 'car-insurance', id: 'c1' },
      });
    });

    it('una cuota más lejos que 5 días no se pide (ni se avisa)', async () => {
      cuotas = [cuota({ dueDate: '2026-11-10', graceUntil: '2026-11-15' })];
      await cron.avisar(AHORA);
      expect(update).not.toHaveBeenCalled();
    });

    it('una cuota ya aprobada avisa como antes, sin volver a pedir aprobación', async () => {
      cuotas = [cuota({ approvalStatus: InstallmentApprovalStatus.APPROVED })];
      await cron.avisar(AHORA);
      expect(update).not.toHaveBeenCalled();
      expect(avisos()[0].link).toEqual({ entity: 'car-insurance', id: 'c1' });
      expect(avisos()[0].body).not.toContain('¿Aprobar el pago?');
    });

    it('si otra corrida ya la había pedido (nada afectado), el aviso no promete una aprobación', async () => {
      update.mockResolvedValue({ affected: 0 });
      cuotas = [cuota()];
      await cron.avisar(AHORA);
      expect(avisos()[0].link).toEqual({ entity: 'car-insurance', id: 'c1' });
    });

    it('fuera de la hora del aviso de la distribuidora no pide nada', async () => {
      esLaHora.mockResolvedValue(false);
      cuotas = [cuota()];
      await cron.avisar(AHORA);
      expect(update).not.toHaveBeenCalled();
    });
  });

  it('cuota con la gracia vencida: aviso aparte con su propia clave', async () => {
    cuotas = [cuota({ dueDate: '2026-10-22', graceUntil: '2026-10-27' })];
    await cron.avisar(AHORA);

    const [aviso] = avisos();
    expect(aviso).toMatchObject({
      kind: 'insurance_installment_overdue',
      dedupeKey: 'insurance-installment:q1:overdue:2026-10-22',
      email: true,
    });
    expect(aviso.body).toContain('venció');
  });

  it('cuota vencida pero todavía en término avisa como «por vencer»', async () => {
    cuotas = [cuota({ dueDate: '2026-10-29', graceUntil: '2026-11-03' })];
    await cron.avisar(AHORA);
    expect(avisos()[0].kind).toBe('insurance_installment_due');
  });

  it('póliza que vence en 30 días o menos sin reemplazo: aviso con su clave y mail', async () => {
    polizas = [poliza()];
    await cron.avisar(AHORA);

    const [aviso] = avisos();
    expect(aviso).toMatchObject({
      distributorId: 'd1',
      kind: 'insurance_policy_expiring',
      dedupeKey: 'insurance-policy:p1:expiring',
      link: { entity: 'car-insurance', id: 'c1' },
      email: true,
    });
    expect(aviso.body).toContain('Seguros Rivadavia');
    expect(aviso.body).toContain('20/11/2026');
    expect(aviso.body).toContain('67/02/192143');
  });

  it('las consultas acotan por ventana: 5 días para cuotas, 30 para pólizas, y excluyen las que otra póliza reemplaza', async () => {
    await cron.avisar(AHORA);
    expect(filtros).toEqual(
      expect.arrayContaining([
        expect.stringContaining('c.due_date <= :limite'),
        expect.stringContaining('p.valid_to <= :limite'),
        expect.stringContaining('NOT EXISTS'),
        expect.stringContaining('q."valid_from" <= p."valid_to"'),
      ]),
    );
  });

  it('sólo avisa a la hora del aviso de flota de cada distribuidora', async () => {
    cuotas = [
      cuota(),
      cuota({
        installmentId: 'q2',
        distributorId: 'd2',
        policy: cuota().policy,
      }),
    ];
    esLaHora.mockImplementation((d: string) => Promise.resolve(d === 'd2'));
    await cron.avisar(AHORA);

    expect(esLaHora).toHaveBeenCalledWith('d1', 8);
    expect(esLaHora).toHaveBeenCalledWith('d2', 8);
    expect(avisos().map((a) => a.distributorId)).toEqual(['d2']);
  });

  it('una fecha de vencimiento corregida genera otra clave y vuelve a avisar', async () => {
    cuotas = [cuota({ dueDate: '2026-11-04', graceUntil: '2026-11-09' })];
    await cron.avisar(AHORA);
    expect(avisos()[0].dedupeKey).toBe(
      'insurance-installment:q1:due:approval:2026-11-04',
    );
  });

  it('antes de avisar completa la sincronización con flota de las pólizas que ya empezaron, a la hora de su distribuidora', async () => {
    pendientes = [poliza({ distributorId: 'd1' })];
    await cron.avisar(AHORA);
    expect(completarPendientes).toHaveBeenCalledWith('d1', '2026-10-31');
  });

  it('fuera de la hora del aviso no sincroniza', async () => {
    pendientes = [poliza({ distributorId: 'd1' })];
    esLaHora.mockResolvedValue(false);
    await cron.avisar(AHORA);
    expect(completarPendientes).not.toHaveBeenCalled();
  });

  it('las consultas de cuotas y pólizas incluyen las aseguradoras dadas de baja', async () => {
    await cron.avisar(AHORA);
    expect(conBajas).toBe(2);
  });

  it('sin nada por avisar no emite ni pregunta la hora', async () => {
    await cron.avisar(AHORA);
    expect(emit).not.toHaveBeenCalled();
    expect(esLaHora).not.toHaveBeenCalled();
  });

  it('si una distribuidora falla, las demás se avisan igual', async () => {
    cuotas = [cuota(), cuota({ installmentId: 'q2', distributorId: 'd2' })];
    esLaHora.mockImplementation((d: string) =>
      d === 'd1'
        ? Promise.reject(new Error('redis caído'))
        : Promise.resolve(true),
    );
    await cron.avisar(AHORA);
    expect(avisos().map((a) => a.distributorId)).toEqual(['d2']);
  });
});
