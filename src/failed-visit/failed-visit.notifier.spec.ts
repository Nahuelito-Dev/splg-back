import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { EVENTO_NOTIFICAR_ADMIN } from '../common/events/notificar-admin.event';
import { marcaDeDistribuidora } from '../email/layout/marca-de-correo';
import { MarcasDeCorreo } from '../email/marcas-de-correo.service';
import { EmailSenderPort } from '../email/ports/email-sender.port';
import { AdminGateway } from '../gateways/admin.gateway';
import { CustomersGateway } from '../gateways/customers.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { RevisitStatus } from './domain/nueva-visita';
import {
  FailedVisitNotifier,
  PedidoParaAvisar,
  cuandoLegible,
} from './failed-visit.notifier';

const ORDEN = '11111111-1111-4111-8111-111111abc123';

const pedido = (o: Partial<PedidoParaAvisar> = {}): PedidoParaAvisar => ({
  orderId: ORDEN,
  distributorId: 'dist',
  customerId: 'cli',
  failedVisitCount: 1,
  revisitStatus: RevisitStatus.PROPOSED,
  scheduledDate: '2026-11-26',
  timeSlotId: 'manana',
  ...o,
});

function armar(o: { email?: string | null; falla?: boolean } = {}) {
  const dataSource = {
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('time_slot')
          ? [{ name: 'Mañana', startTime: '09:00:00', endTime: '13:00:00' }]
          : [{ email: o.email === undefined ? 'ana@correo.com' : o.email }],
      ),
    ),
  };
  const customers = {
    notifyCustomer: jest.fn(() => {
      if (o.falla) throw new Error('socket');
    }),
  };
  const admins = {
    notifyAdmins: jest.fn(() => {
      if (o.falla) throw new Error('socket');
    }),
  };
  const notifications = {
    sendOrderNoticePush: jest.fn().mockResolvedValue(undefined),
  };
  const events = { emit: jest.fn() };
  const correo = {
    send: o.falla
      ? jest.fn().mockRejectedValue(new Error('resend'))
      : jest.fn().mockResolvedValue(undefined),
  };
  const marcas = {
    deDistribuidora: jest
      .fn()
      .mockResolvedValue(marcaDeDistribuidora('Gas SA')),
  };
  const n = new FailedVisitNotifier(
    dataSource as unknown as DataSource,
    customers as unknown as CustomersGateway,
    admins as unknown as AdminGateway,
    notifications as unknown as NotificationsService,
    events as unknown as EventEmitter2,
    correo as unknown as EmailSenderPort,
    marcas as unknown as MarcasDeCorreo,
  );
  return { n, customers, admins, notifications, events, correo, dataSource };
}

describe('FailedVisitNotifier', () => {
  it('cuandoLegible: el día con la franja, o sólo el día', () => {
    expect(
      cuandoLegible('2026-11-26', {
        startTime: '09:00:00',
        endTime: '13:00:00',
      }),
    ).toBe('el jueves 26/11 entre las 09:00 y las 13:00');
    expect(cuandoLegible('2026-11-26', null)).toBe('el jueves 26/11');
  });

  it('propuesta: al cliente por socket, push y correo con el día, la franja y la invitación a elegir otro; al panel por socket', async () => {
    const t = armar();
    await t.n.visitaFallida(pedido(), 'El cliente no estaba');

    expect(t.customers.notifyCustomer).toHaveBeenCalledWith(
      'cli',
      'order:rescheduled',
      {
        orderId: ORDEN,
        scheduledDate: '2026-11-26',
        timeSlotId: 'manana',
        timeSlotName: 'Mañana',
        windowStart: '09:00:00',
        windowEnd: '13:00:00',
        revisitStatus: RevisitStatus.PROPOSED,
        failedVisitCount: 1,
        canRespond: true,
      },
    );
    expect(t.notifications.sendOrderNoticePush).toHaveBeenCalledWith(
      'cli',
      ORDEN,
      {
        title: 'No te encontramos',
        body: 'Pasamos y no pudimos entregarte el pedido. Volvemos el jueves 26/11 entre las 09:00 y las 13:00. Si no te sirve, elegí otro día y horario en la app.',
        event: 'ORDER_RESCHEDULED',
      },
      undefined,
      'dist',
    );
    expect(t.correo.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ana@correo.com',
        subject:
          'No te encontramos: volvemos el jueves 26/11 entre las 09:00 y las 13:00',
      }),
    );
    expect(t.admins.notifyAdmins).toHaveBeenCalledWith(
      'order:failed-visit',
      expect.objectContaining({
        orderId: ORDEN,
        reason: 'El cliente no estaba',
        revisitStatus: RevisitStatus.PROPOSED,
      }),
      'dist',
    );
    // No pide una decisión: no va a la bandeja.
    expect(t.events.emit).not.toHaveBeenCalled();
  });

  it('acordada con el chofer: no invita a elegir otro día', async () => {
    const t = armar();
    await t.n.visitaFallida(
      pedido({ revisitStatus: RevisitStatus.CONFIRMED }),
      'El cliente no estaba',
    );
    const [, , aviso] = t.notifications.sendOrderNoticePush.mock.calls[0] as [
      string,
      string,
      { body: string },
    ];
    expect(aviso.body).toContain('Como acordamos, volvemos el jueves 26/11');
    expect(aviso.body).not.toContain('elegí otro día');
    expect(t.customers.notifyCustomer).toHaveBeenCalledWith(
      'cli',
      'order:rescheduled',
      expect.objectContaining({ canRespond: false }),
    );
  });

  it('decide el admin: al cliente, que la distribuidora se comunica; al admin, a la bandeja con el enlace al pedido', async () => {
    const t = armar();
    await t.n.visitaFallida(
      pedido({
        revisitStatus: RevisitStatus.AWAITING_ADMIN,
        failedVisitCount: 2,
      }),
      'El domicilio estaba cerrado',
    );
    expect(t.customers.notifyCustomer).toHaveBeenCalledWith(
      'cli',
      'order:delivery-failed',
      {
        orderId: ORDEN,
        attempt: 2,
        revisitStatus: RevisitStatus.AWAITING_ADMIN,
      },
    );
    expect(t.notifications.sendOrderNoticePush).toHaveBeenCalledWith(
      'cli',
      ORDEN,
      expect.objectContaining({ event: 'ORDER_DELIVERY_FAILED' }),
      undefined,
      'dist',
    );
    expect(t.events.emit).toHaveBeenCalledWith(
      EVENTO_NOTIFICAR_ADMIN,
      expect.objectContaining({
        distributorId: 'dist',
        kind: 'order_failed_visit_needs_admin',
        body: 'El pedido ABC123 lleva 2 visitas fallidas (El domicilio estaba cerrado). Fijale día y franja, reasignalo o cancelalo: no vuelve solo al despacho.',
        link: { entity: 'order', id: ORDEN },
        dedupeKey: `order-failed-visit:${ORDEN}:2`,
      }),
    );
  });

  it('sin correo cargado no manda correo; un canal que falla no corta los demás', async () => {
    const sinCorreo = armar({ email: null });
    await sinCorreo.n.visitaFallida(pedido(), 'x');
    expect(sinCorreo.correo.send).not.toHaveBeenCalled();

    const roto = armar({ falla: true });
    await expect(roto.n.visitaFallida(pedido(), 'x')).resolves.toBeUndefined();
    expect(roto.notifications.sendOrderNoticePush).toHaveBeenCalled();
  });

  it('el cliente aceptó: se actualiza su app y el panel, sin bandeja', async () => {
    const t = armar();
    await t.n.respondida(
      pedido({ revisitStatus: RevisitStatus.CONFIRMED }),
      false,
    );
    expect(t.customers.notifyCustomer).toHaveBeenCalledWith(
      'cli',
      'order:rescheduled',
      expect.objectContaining({ revisitStatus: RevisitStatus.CONFIRMED }),
    );
    expect(t.admins.notifyAdmins).toHaveBeenCalledWith(
      'order:revisit-updated',
      expect.objectContaining({ orderId: ORDEN }),
      'dist',
    );
    expect(t.events.emit).not.toHaveBeenCalled();
  });

  it('el cliente eligió otro día: además, aviso informativo en la bandeja del admin', async () => {
    const t = armar();
    await t.n.respondida(
      pedido({ revisitStatus: RevisitStatus.CONFIRMED }),
      true,
    );
    expect(t.events.emit).toHaveBeenCalledWith(
      EVENTO_NOTIFICAR_ADMIN,
      expect.objectContaining({
        kind: 'order_revisit_changed_by_customer',
        body: 'El pedido ABC123 se entrega el jueves 26/11 entre las 09:00 y las 13:00.',
      }),
    );
  });

  it('el admin fijó la visita: socket, push y correo al cliente con la fecha', async () => {
    const t = armar();
    await t.n.fijadaPorElAdmin(
      pedido({ revisitStatus: RevisitStatus.CONFIRMED, timeSlotId: null }),
    );
    expect(t.notifications.sendOrderNoticePush).toHaveBeenCalledWith(
      'cli',
      ORDEN,
      {
        title: 'Nueva fecha de entrega',
        body: 'La distribuidora coordinó la entrega de tu pedido: pasamos el jueves 26/11.',
        event: 'ORDER_RESCHEDULED',
      },
      undefined,
      'dist',
    );
    expect(t.correo.send).toHaveBeenCalled();

    const sinFecha = armar();
    await sinFecha.n.fijadaPorElAdmin(pedido({ scheduledDate: null }));
    expect(sinFecha.notifications.sendOrderNoticePush).not.toHaveBeenCalled();
  });

  it('si la franja no se puede leer, el aviso sale con el día solo', async () => {
    const t = armar();
    t.dataSource.query.mockImplementation((sql: string) =>
      sql.includes('time_slot')
        ? Promise.reject(new Error('db'))
        : Promise.resolve([{ email: null }]),
    );
    await t.n.visitaFallida(pedido(), 'x');
    const [, , aviso] = t.notifications.sendOrderNoticePush.mock.calls[0] as [
      string,
      string,
      { body: string },
    ];
    expect(aviso.body).toContain('Volvemos el jueves 26/11. Si no te sirve');
  });
});
