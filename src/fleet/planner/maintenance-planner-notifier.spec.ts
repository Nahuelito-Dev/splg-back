import type { EventEmitter2 } from '@nestjs/event-emitter';
import { EmailSenderPort } from '../../email/ports/email-sender.port';
import { FcmPort } from '../../firebase/ports/fcm.port';
import { DriversGateway } from '../../gateways/drivers.gateway';
import { Delivery } from '../../delivery/entities/delivery.entity';
import {
  MaintenancePlanningCase,
  PlanningEscalationReason,
  PlanningWindowSource,
} from '../entities/maintenance-planning-case.entity';
import { MaintenanceWindowProposal } from '../entities/maintenance-window-proposal.entity';
import {
  MaintenancePlannerNotifier,
  textoDeEscalamiento,
} from './maintenance-planner-notifier';
import { EVENTO_NOTIFICAR_ADMIN } from '../../common/events/notificar-admin.event';

const CTX = { planName: 'VTV <b>', patent: 'AB123CD' };
const propuesta = {
  proposalId: 'p1',
  taskId: 't1',
  windowStart: new Date('2026-11-02T11:00:00Z'),
  windowEnd: new Date('2026-11-02T16:00:00Z'),
  expiresAt: new Date('2026-10-31T22:00:00Z'),
} as MaintenanceWindowProposal;
const caso = (over: Partial<MaintenancePlanningCase> = {}) =>
  ({
    caseId: 'c1',
    distributorId: 'd1',
    taskId: 't1',
    chosenStart: new Date('2026-11-02T11:00:00Z'),
    chosenEnd: new Date('2026-11-02T16:00:00Z'),
    escalationReason: PlanningEscalationReason.EXHAUSTED,
    ...over,
  }) as MaintenancePlanningCase;

describe('MaintenancePlannerNotifier', () => {
  let drivers: { notifyMaintenance: jest.Mock };
  let fcm: { sendToToken: jest.Mock };
  let email: { send: jest.Mock };
  let events: { emit: jest.Mock };
  let notifier: MaintenancePlannerNotifier;
  const delivery = (over: Partial<Delivery> = {}) =>
    ({
      userId: 'u1',
      notificationToken: 'tok',
      user: { email: 'a@b.com' },
      ...over,
    }) as Delivery;

  beforeEach(() => {
    drivers = { notifyMaintenance: jest.fn() };
    fcm = { sendToToken: jest.fn().mockResolvedValue('id') };
    email = { send: jest.fn().mockResolvedValue(undefined) };
    events = { emit: jest.fn() };
    notifier = new MaintenancePlannerNotifier(
      drivers as unknown as DriversGateway,
      fcm as unknown as FcmPort,
      email as unknown as EmailSenderPort,
      events as unknown as EventEmitter2,
    );
  });

  it('la propuesta le llega al chofer por socket, push y correo', async () => {
    await notifier.propuestaAlChofer(delivery(), propuesta, CTX, true);

    expect(drivers.notifyMaintenance).toHaveBeenCalledWith(
      'u1',
      'maintenance:proposal',
      expect.objectContaining({ proposalId: 'p1', patent: 'AB123CD' }),
    );
    expect(fcm.sendToToken).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({
        data: { type: 'MAINTENANCE_PROPOSAL', proposalId: 'p1' },
      }),
    );
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.com' }),
    );
  });

  it('sin el parámetro de la distribuidora no manda correo, aunque el chofer tenga uno', async () => {
    await notifier.propuestaAlChofer(delivery(), propuesta, CTX, false);
    expect(email.send).not.toHaveBeenCalled();
    expect(drivers.notifyMaintenance).toHaveBeenCalled();
  });

  it('el correo escapa el HTML del nombre de la tarea', async () => {
    await notifier.propuestaAlChofer(delivery(), propuesta, CTX, true);
    const [[{ html }]] = email.send.mock.calls as [[{ html: string }]];
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('sin token ni correo sólo usa el socket', async () => {
    await notifier.propuestaAlChofer(
      delivery({ notificationToken: undefined, user: undefined }),
      propuesta,
      CTX,
      true,
    );
    expect(drivers.notifyMaintenance).toHaveBeenCalled();
    expect(fcm.sendToToken).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('si un canal falla, los demás se entregan y no se propaga', async () => {
    drivers.notifyMaintenance.mockImplementation(() => {
      throw new Error('socket caído');
    });
    fcm.sendToToken.mockRejectedValue(new Error('fcm caído'));

    await expect(
      notifier.propuestaAlChofer(delivery(), propuesta, CTX, true),
    ).resolves.toBeUndefined();

    expect(email.send).toHaveBeenCalled();
  });

  it('avisa que la propuesta se cerró', () => {
    notifier.propuestaCerrada('u1', 'p1', 'expired');
    expect(drivers.notifyMaintenance).toHaveBeenCalledWith(
      'u1',
      'maintenance:proposal-closed',
      { proposalId: 'p1', reason: 'expired' },
    );
  });

  it('avisa la confirmación del taller por socket y push', async () => {
    await notifier.ventanaConfirmada(delivery(), caso(), CTX);
    expect(drivers.notifyMaintenance).toHaveBeenCalledWith(
      'u1',
      'maintenance:window-confirmed',
      expect.objectContaining({ caseId: 'c1' }),
    );
    expect(fcm.sendToToken).toHaveBeenCalled();
  });

  it('no avisa una confirmación sin ventana', async () => {
    await notifier.ventanaConfirmada(
      delivery(),
      caso({ chosenStart: null }),
      CTX,
    );
    expect(drivers.notifyMaintenance).not.toHaveBeenCalled();
  });

  it('al administrador le pide el aviso del acuerdo con el link al caso', () => {
    notifier.alAdminVentanaAcordada(caso(), CTX, false);
    expect(events.emit).toHaveBeenCalledWith(
      EVENTO_NOTIFICAR_ADMIN,
      expect.objectContaining({
        kind: 'maintenance_window_agreed',
        link: { entity: 'maintenance-planner', id: 'c1' },
        email: false,
      }),
    );
  });

  it('el escalamiento va por correo la primera vez y sin correo al reiterarse', () => {
    notifier.alAdminEscalado(caso(), CTX, '2026-10-30', false);
    notifier.alAdminEscalado(caso(), CTX, '2026-10-31', true);
    const [primero, repetido] = events.emit.mock.calls.map(
      (c: unknown[]) =>
        c[1] as { email: boolean; dedupeKey: string; kind: string },
    );
    expect(primero).toMatchObject({
      kind: 'maintenance_escalated',
      email: true,
      dedupeKey: 'maintenance-case:c1:escalated',
    });
    expect(repetido).toMatchObject({
      email: false,
      dedupeKey: 'maintenance-case:c1:escalated:2026-10-31',
    });
  });

  it('le avisa al chofer que el caso se escaló, para que la app lo saque', () => {
    notifier.escaladoAlChofer(delivery(), caso(), CTX);
    expect(drivers.notifyMaintenance).toHaveBeenCalledWith(
      'u1',
      'maintenance:case-escalated',
      expect.objectContaining({ caseId: 'c1', reason: 'exhausted' }),
    );
  });

  it('la confirmación lleva quién fijó la ventana', async () => {
    await notifier.ventanaConfirmada(
      delivery(),
      caso({ chosenSource: PlanningWindowSource.ADMIN }),
      CTX,
    );
    expect(drivers.notifyMaintenance).toHaveBeenCalledWith(
      'u1',
      'maintenance:window-confirmed',
      expect.objectContaining({ source: 'admin' }),
    );
  });

  it('un acordado sin confirmar se recuerda una vez por día, y avisa si la ventana ya pasó', () => {
    notifier.alAdminAcordadoPendiente(
      caso({ chosenStart: new Date('2020-01-01T11:00:00Z') }),
      CTX,
      '2026-10-31',
    );
    notifier.alAdminAcordadoPendiente(
      caso({ chosenStart: new Date('2099-01-01T11:00:00Z') }),
      CTX,
      '2026-10-31',
    );
    const [vencida, vigente] = events.emit.mock.calls.map(
      (c: unknown[]) =>
        c[1] as { body: string; dedupeKey: string; email: boolean },
    );
    expect(vencida.body).toContain('ya pasó');
    expect(vigente.body).not.toContain('ya pasó');
    expect(vencida.dedupeKey).toBe(
      'maintenance-case:c1:agreed-reminder:2026-10-31',
    );
    expect(vencida.email).toBe(false);
  });

  it('el aviso de vehículo fuera de servicio lleva al vehículo', () => {
    notifier.alAdminVehiculoFueraDeServicio('d1', 'car-1', CTX, '2026-10-30');
    expect(events.emit).toHaveBeenCalledWith(
      EVENTO_NOTIFICAR_ADMIN,
      expect.objectContaining({
        kind: 'vehicle_grounded_expired',
        link: { entity: 'car', id: 'car-1' },
      }),
    );
  });

  it.each(Object.values(PlanningEscalationReason))(
    'explica el escalamiento %s',
    (motivo) => {
      expect(textoDeEscalamiento(motivo).length).toBeGreaterThan(10);
    },
  );
});
