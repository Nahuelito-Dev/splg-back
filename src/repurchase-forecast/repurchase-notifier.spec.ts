import { CustomersService } from '../customer/customer.service';
import { FcmPort } from '../firebase/ports/fcm.port';
import { CustomersGateway } from '../gateways/customers.gateway';
import { RepurchaseInvitation } from './entities/repurchase-invitation.entity';
import {
  EVENTO_INVITACION,
  EVENTO_INVITACION_CERRADA,
  RepurchaseNotifier,
} from './repurchase-notifier';

const invitacion = (unidades = 2): RepurchaseInvitation =>
  ({
    invitationId: 'i1',
    distributorId: 'd1',
    userId: 'u1',
    projectedDepletionAt: new Date('2026-11-03T15:00:00Z'),
    expiresAt: new Date('2026-11-01T15:00:00Z'),
    suggestedItems: [{ gasCylinderId: 'g', quantity: unidades }],
  }) as RepurchaseInvitation;

describe('RepurchaseNotifier', () => {
  let gateway: { notifyCustomer: jest.Mock };
  let customers: { findNotificationToken: jest.Mock };
  let fcm: { sendToToken: jest.Mock };
  let notifier: RepurchaseNotifier;

  beforeEach(() => {
    gateway = { notifyCustomer: jest.fn() };
    customers = {
      findNotificationToken: jest
        .fn()
        .mockResolvedValue({ esCliente: true, token: 'tok' }),
    };
    fcm = { sendToToken: jest.fn().mockResolvedValue('msg') };
    notifier = new RepurchaseNotifier(
      gateway as unknown as CustomersGateway,
      customers as unknown as CustomersService,
      fcm as unknown as FcmPort,
    );
  });

  it('una invitación nueva le llega al cliente por socket y por push', async () => {
    await notifier.invitar(invitacion());

    expect(gateway.notifyCustomer).toHaveBeenCalledWith(
      'u1',
      EVENTO_INVITACION,
      {
        invitationId: 'i1',
        distributorId: 'd1',
        projectedDepletionAt: '2026-11-03T15:00:00.000Z',
        expiresAt: '2026-11-01T15:00:00.000Z',
      },
    );
    const [token, mensaje] = fcm.sendToToken.mock.calls[0] as [
      string,
      {
        notification: { title: string; body: string };
        data: Record<string, string>;
      },
    ];
    expect(token).toBe('tok');
    expect(mensaje.notification.title).toBe('¿Reponés tu garrafa?');
    expect(mensaje.notification.body).toContain('2 garrafas');
    expect(mensaje.data).toEqual({
      event: 'REPURCHASE_INVITATION',
      invitationId: 'i1',
      distributorId: 'd1',
    });
  });

  it('con una sola garrafa el texto va en singular', async () => {
    await notifier.invitar(invitacion(1));
    const [, { notification }] = fcm.sendToToken.mock.calls[0] as [
      string,
      { notification: { body: string } },
    ];
    expect(notification.body).toContain('1 garrafa ');
  });

  it('sin token no manda push', async () => {
    customers.findNotificationToken.mockResolvedValue({
      esCliente: true,
      token: null,
    });
    await notifier.invitar(invitacion());
    expect(fcm.sendToToken).not.toHaveBeenCalled();
    expect(gateway.notifyCustomer).toHaveBeenCalled();
  });

  it('un aviso que falla no rompe: se registra y el otro canal sigue', async () => {
    gateway.notifyCustomer.mockImplementation(() => {
      throw new Error('socket caído');
    });
    fcm.sendToToken.mockRejectedValue(new Error('NotRegistered'));
    await expect(notifier.invitar(invitacion())).resolves.toBeUndefined();
    expect(fcm.sendToToken).toHaveBeenCalled();
  });

  it('cuando la invitación se cierra, la app la saca de la lista', async () => {
    await notifier.cerrada(invitacion(), 'expired');
    expect(gateway.notifyCustomer).toHaveBeenCalledWith(
      'u1',
      EVENTO_INVITACION_CERRADA,
      { invitationId: 'i1', reason: 'expired' },
    );
  });
});
