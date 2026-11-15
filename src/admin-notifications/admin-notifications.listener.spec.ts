import { AdminService } from '../admin/admin.service';
import { NotificarAdminEvent } from '../common/events/notificar-admin.event';
import { EnlacesDeLaApp } from '../email/enlaces-de-la-app';
import { marcaDeDistribuidora } from '../email/layout/marca-de-correo';
import { MarcasDeCorreo } from '../email/marcas-de-correo.service';
import { EmailSenderPort } from '../email/ports/email-sender.port';
import { AdminGateway } from '../gateways/admin.gateway';
import {
  AdminNotificationsListener,
  EVENTO_AVISO_EN_VIVO,
} from './admin-notifications.listener';
import { AdminNotificationsService } from './admin-notifications.service';
import { AdminNotification } from './entities/admin-notification.entity';

function aviso(parcial: Partial<AdminNotification> = {}): AdminNotification {
  return {
    notificationId: 'n-1',
    distributorId: 'd1',
    kind: 'claim_created',
    title: 'Nuevo reclamo',
    body: 'Pedido #ABC123: Fuga',
    linkEntity: 'order',
    linkId: 'o-1',
    dedupeKey: 'claim:c-1',
    email: false,
    emailedAt: null,
    createdAt: new Date('2026-10-28T12:00:00Z'),
    ...parcial,
  };
}

function evento(email = false): NotificarAdminEvent {
  return new NotificarAdminEvent(
    'd1',
    'claim_created',
    'Nuevo reclamo',
    'Pedido #ABC123: Fuga',
    { entity: 'order', id: 'o-1' },
    email,
    'claim:c-1',
  );
}

describe('AdminNotificationsListener', () => {
  let bandeja: { registrar: jest.Mock; marcarCorreoEnviado: jest.Mock };
  let gateway: { notifyAdmins: jest.Mock };
  let admins: { emailsDeAdminsActivos: jest.Mock };
  let emailSender: { send: jest.Mock };
  let marcas: { deDistribuidora: jest.Mock };
  let listener: AdminNotificationsListener;

  beforeEach(() => {
    bandeja = {
      registrar: jest.fn().mockResolvedValue(aviso()),
      marcarCorreoEnviado: jest.fn().mockResolvedValue(undefined),
    };
    gateway = { notifyAdmins: jest.fn() };
    admins = {
      emailsDeAdminsActivos: jest.fn().mockResolvedValue(['a@x.com']),
    };
    emailSender = { send: jest.fn().mockResolvedValue(undefined) };
    marcas = {
      deDistribuidora: jest
        .fn()
        .mockResolvedValue(marcaDeDistribuidora('Gas del Sur', {})),
    };
    listener = new AdminNotificationsListener(
      bandeja as unknown as AdminNotificationsService,
      gateway as unknown as AdminGateway,
      admins as unknown as AdminService,
      emailSender as unknown as EmailSenderPort,
      {
        panel: (ruta: string) => `https://panel.test/${ruta}`,
      } as unknown as EnlacesDeLaApp,
      marcas as unknown as MarcasDeCorreo,
    );
  });

  it('guarda el aviso y lo empuja por el socket a los admins de esa distribuidora', async () => {
    await listener.handle(evento());

    expect(bandeja.registrar).toHaveBeenCalledWith(evento());
    expect(gateway.notifyAdmins).toHaveBeenCalledWith(
      EVENTO_AVISO_EN_VIVO,
      expect.objectContaining({
        id: 'n-1',
        kind: 'claim_created',
        link: { entity: 'order', id: 'o-1' },
        readAt: null,
        distributorId: 'd1',
      }),
      'd1',
    );
  });

  it('un aviso de la plataforma va a la sala de la plataforma y no por correo a ninguna empresa', async () => {
    bandeja.registrar.mockResolvedValue(
      aviso({ distributorId: null, email: true }),
    );

    await listener.handle(evento(true));

    expect(gateway.notifyAdmins).toHaveBeenCalledWith(
      EVENTO_AVISO_EN_VIVO,
      expect.objectContaining({ distributorId: null }),
      null,
    );
    expect(admins.emailsDeAdminsActivos).not.toHaveBeenCalled();
    expect(emailSender.send).not.toHaveBeenCalled();
  });

  it('un aviso repetido (misma dedupeKey) no vuelve a emitirse ni a mandar mail', async () => {
    bandeja.registrar.mockResolvedValue(null);

    await listener.handle(evento(true));

    expect(gateway.notifyAdmins).not.toHaveBeenCalled();
    expect(emailSender.send).not.toHaveBeenCalled();
  });

  it('sin email:true no manda ningún correo', async () => {
    await listener.handle(evento(false));

    expect(admins.emailsDeAdminsActivos).not.toHaveBeenCalled();
    expect(emailSender.send).not.toHaveBeenCalled();
  });

  it('el asunto del correo va en una sola línea (un salto no se cuela como cabecera)', async () => {
    bandeja.registrar.mockResolvedValue(
      aviso({ email: true, title: 'Vence la VTV\r\nBcc: x@y.com' }),
    );
    admins.emailsDeAdminsActivos.mockResolvedValue(['a@x.com']);

    await listener.handle(evento(true));

    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Vence la VTV Bcc: x@y.com' }),
    );
  });

  it('con email:true manda un correo a cada admin activo de la distribuidora y anota el envío', async () => {
    bandeja.registrar.mockResolvedValue(aviso({ email: true }));
    admins.emailsDeAdminsActivos.mockResolvedValue(['a@x.com', 'b@x.com']);

    await listener.handle(evento(true));

    expect(admins.emailsDeAdminsActivos).toHaveBeenCalledWith('d1');
    expect(emailSender.send).toHaveBeenCalledTimes(2);
    expect(emailSender.send).toHaveBeenCalledWith({
      to: 'a@x.com',
      subject: 'Nuevo reclamo',
      html: expect.stringContaining('https://panel.test/orders/o-1') as string,
      text: expect.stringContaining(
        'Ver en el panel: https://panel.test/orders/o-1',
      ) as string,
    });
    expect(bandeja.marcarCorreoEnviado).toHaveBeenCalledTimes(1);
  });

  it('escapa el título y el cuerpo en el HTML del correo', async () => {
    bandeja.registrar.mockResolvedValue(
      aviso({
        email: true,
        title: '<b>Hola</b>',
        body: '<script>alert("x")</script> & "más"',
      }),
    );

    await listener.handle(evento(true));

    const [{ html }] = emailSender.send.mock.calls[0] as [{ html: string }];
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('&amp;');
  });

  it('sin destino el correo no lleva enlace', async () => {
    bandeja.registrar.mockResolvedValue(
      aviso({ email: true, linkEntity: null, linkId: null }),
    );

    await listener.handle(evento(true));

    const [{ html }] = emailSender.send.mock.calls[0] as [{ html: string }];
    expect(html).not.toContain('Ver en el panel');
    expect(html).not.toContain('panel.test');
  });

  it('el correo sale con el nombre de la distribuidora del aviso', async () => {
    bandeja.registrar.mockResolvedValue(aviso({ email: true }));

    await listener.handle(evento(true));

    expect(marcas.deDistribuidora).toHaveBeenCalledWith('d1');
    const [{ html }] = emailSender.send.mock.calls[0] as [{ html: string }];
    expect(html).toContain('Gas del Sur');
  });

  it('un fallo de envío no rompe: se registra, el resto sale y no se reintenta', async () => {
    bandeja.registrar.mockResolvedValue(aviso({ email: true }));
    admins.emailsDeAdminsActivos.mockResolvedValue(['a@x.com', 'b@x.com']);
    emailSender.send
      .mockRejectedValueOnce(new Error('Resend caído'))
      .mockResolvedValueOnce(undefined);

    await expect(listener.handle(evento(true))).resolves.toBeUndefined();

    expect(emailSender.send).toHaveBeenCalledTimes(2);
    expect(bandeja.marcarCorreoEnviado).toHaveBeenCalledTimes(1);
  });

  it('si no salió ningún correo, no se anota como enviado', async () => {
    bandeja.registrar.mockResolvedValue(aviso({ email: true }));
    emailSender.send.mockRejectedValue(new Error('Resend caído'));

    await listener.handle(evento(true));

    expect(bandeja.marcarCorreoEnviado).not.toHaveBeenCalled();
  });

  it('una distribuidora sin admins activos no manda nada', async () => {
    bandeja.registrar.mockResolvedValue(aviso({ email: true }));
    admins.emailsDeAdminsActivos.mockResolvedValue([]);

    await listener.handle(evento(true));

    expect(emailSender.send).not.toHaveBeenCalled();
    expect(bandeja.marcarCorreoEnviado).not.toHaveBeenCalled();
  });

  it('un error al guardar se registra y no llega a quien emitió', async () => {
    bandeja.registrar.mockRejectedValue(new Error('base caída'));

    await expect(listener.handle(evento(true))).resolves.toBeUndefined();

    expect(gateway.notifyAdmins).not.toHaveBeenCalled();
  });

  it('un socket caído no impide el correo', async () => {
    bandeja.registrar.mockResolvedValue(aviso({ email: true }));
    gateway.notifyAdmins.mockImplementation(() => {
      throw new Error('socket caído');
    });

    await listener.handle(evento(true));

    expect(emailSender.send).toHaveBeenCalledTimes(1);
  });
});
