import { EventEmitter2 } from '@nestjs/event-emitter';
import { CustomersService } from '../../customer/customer.service';
import { FcmPort } from '../../firebase/ports/fcm.port';
import { CustomersGateway } from '../../gateways/customers.gateway';
import { EVENTO_NOTIFICAR_ADMIN } from '../../common/events/notificar-admin.event';
import { RecoveryNoticeKind } from '../entities/cylinder-recovery-notice.entity';
import {
  AVISO_RECUPERO_ESCALADO,
  CylinderRecoveryNotifier,
  ENTIDAD_CASO_DE_RECUPERO,
  EVENTO_AVISO_DE_RECUPERO,
  textoDelAviso,
} from './cylinder-recovery.notifier';
import { unAviso, unCaso, unaOferta } from './recovery-test-kit';

describe('CylinderRecoveryNotifier', () => {
  let customers: { notifyCustomer: jest.Mock };
  let customersService: { findNotificationToken: jest.Mock };
  let fcm: { sendToToken: jest.Mock };
  let events: { emit: jest.Mock };
  let notifier: CylinderRecoveryNotifier;
  const ctx = { serial: 'SN-001', diasAfuera: 40, customerName: 'Ana Pérez' };

  beforeEach(() => {
    customers = { notifyCustomer: jest.fn() };
    customersService = {
      findNotificationToken: jest
        .fn()
        .mockResolvedValue({ esCliente: true, token: 'tok-1' }),
    };
    fcm = { sendToToken: jest.fn().mockResolvedValue('id') };
    events = { emit: jest.fn() };
    notifier = new CylinderRecoveryNotifier(
      customers as unknown as CustomersGateway,
      customersService as unknown as CustomersService,
      fcm as unknown as FcmPort,
      events as unknown as EventEmitter2,
    );
  });

  describe('textos', () => {
    it('el recordatorio dice el envase y los días', () => {
      const t = textoDelAviso(unCaso(), unAviso(), ctx);
      expect(t.body).toContain('SN-001');
      expect(t.body).toContain('40 días');
    });

    it('el aviso del depósito dice el importe comprometido', () => {
      const t = textoDelAviso(
        unCaso({ depositAmount: 70000 }),
        unAviso({ kind: RecoveryNoticeKind.DEPOSIT_WARNING, step: 2 }),
        ctx,
      );
      expect(t.title).toMatch(/depósito/i);
      expect(t.body).toMatch(/70\.000/);
    });

    it('la oferta de retiro dice el día de la entrega', () => {
      const t = textoDelAviso(unCaso(), unaOferta(), {
        ...ctx,
        entregaProgramada: '2026-11-03',
      });
      expect(t.body).toContain('2026-11-03');
    });
  });

  describe('porSocket', () => {
    it('avisa en vivo al cliente del caso, sin push', () => {
      notifier.porSocket(unCaso(), unAviso(), ctx);
      expect(customers.notifyCustomer).toHaveBeenCalledWith(
        'cust-1',
        EVENTO_AVISO_DE_RECUPERO,
        expect.objectContaining({
          caseId: 'case-1',
          kind: RecoveryNoticeKind.REMINDER,
          serial: 'SN-001',
        }),
      );
      expect(fcm.sendToToken).not.toHaveBeenCalled();
    });

    it('un socket que falla no se propaga', () => {
      customers.notifyCustomer.mockImplementation(() => {
        throw new Error('socket caído');
      });
      expect(() => notifier.porSocket(unCaso(), unAviso(), ctx)).not.toThrow();
    });
  });

  describe('alClienteAgrupado (un push por cliente)', () => {
    const item = (caseId: string, serial: string, over = {}) => ({
      caso: unCaso({ caseId }),
      aviso: unAviso({ noticeId: `n-${caseId}`, ...over }),
      ctx: { ...ctx, serial },
    });

    it('con un solo aviso manda su texto, con la empresa y el cliente explícitos', async () => {
      await notifier.alClienteAgrupado('cust-1', [
        {
          ...item('c1', 'SN-1'),
          caso: unCaso({ caseId: 'c1', distributorId: 'dist-9' }),
        },
      ]);
      expect(fcm.sendToToken).toHaveBeenCalledTimes(1);
      const [token, mensaje, contexto] = fcm.sendToToken.mock.calls[0] as [
        string,
        { data: Record<string, string>; notification: { body: string } },
        unknown,
      ];
      expect(token).toBe('tok-1');
      expect(contexto).toEqual({
        type: 'CYLINDER_RECOVERY',
        distributorId: 'dist-9',
        recipientUserId: 'cust-1',
      });
      expect(mensaje.data.type).toBe('CYLINDER_RECOVERY');
      expect(mensaje.notification.body).toContain('SN-1');
    });

    it('con varios envases (y una oferta) manda UN solo push que los resume', async () => {
      await notifier.alClienteAgrupado('cust-1', [
        item('c1', 'SN-1'),
        item('c2', 'SN-2'),
        item('c3', 'SN-3'),
        item('c4', 'SN-4'),
        item('c1', 'SN-1', {
          kind: RecoveryNoticeKind.PICKUP_OFFER,
          noticeId: 'oferta',
        }),
      ]);
      expect(fcm.sendToToken).toHaveBeenCalledTimes(1);
      const [, mensaje] = fcm.sendToToken.mock.calls[0] as [
        string,
        {
          data: Record<string, string>;
          notification: { title: string; body: string };
        },
      ];
      expect(mensaje.notification.title).toBe('Tenés 4 envases sin devolver');
      expect(mensaje.notification.body).toContain('SN-1, SN-2, SN-3 y 1 más');
      expect(mensaje.notification.body).toContain('aceptar');
      expect(mensaje.data.count).toBe('5');
    });

    it('sin avisos o sin dispositivo no manda nada', async () => {
      await notifier.alClienteAgrupado('cust-1', []);
      customersService.findNotificationToken.mockResolvedValue({
        esCliente: true,
        token: null,
      });
      await notifier.alClienteAgrupado('cust-1', [item('c1', 'SN-1')]);
      expect(fcm.sendToToken).not.toHaveBeenCalled();
    });

    it('un push que falla no se propaga', async () => {
      fcm.sendToToken.mockRejectedValue(new Error('fcm caído'));
      await expect(
        notifier.alClienteAgrupado('cust-1', [item('c1', 'SN-1')]),
      ).resolves.toBeUndefined();
    });
  });

  describe('escaladoAlAdmin', () => {
    it('pide un aviso en la bandeja con el legajo como destino, una sola vez por caso', () => {
      notifier.escaladoAlAdmin(unCaso({ depositAmount: 70000 }), ctx);
      expect(events.emit).toHaveBeenCalledWith(
        EVENTO_NOTIFICAR_ADMIN,
        expect.objectContaining({
          distributorId: 'dist-1',
          kind: AVISO_RECUPERO_ESCALADO,
          link: { entity: ENTIDAD_CASO_DE_RECUPERO, id: 'case-1' },
          dedupeKey: 'cylinder-recovery-escalated:case-1',
        }),
      );
      const [, evento] = events.emit.mock.calls[0] as [
        string,
        { body: string },
      ];
      expect(evento.body).toContain('Ana Pérez');
      expect(evento.body).toContain('SN-001');
    });
  });
});
