import { EventEmitter2 } from '@nestjs/event-emitter';
import { EVENTO_NOTIFICAR_ADMIN } from '../../common/events/notificar-admin.event';
import { FcmPort } from '../../firebase/ports/fcm.port';
import { AdminGateway } from '../../gateways/admin.gateway';
import { CustomersGateway } from '../../gateways/customers.gateway';
import { DriversGateway } from '../../gateways/drivers.gateway';
import { NotificationsService } from '../../notifications/notifications.service';
import {
  RouteSheetNotifier,
  diaLegible,
  horaArgentina,
} from './route-sheet-notifier.service';

function armar() {
  const drivers = { notifyRouteBatch: jest.fn() };
  const admins = { notifyAdmins: jest.fn() };
  const customers = { notifyCustomer: jest.fn() };
  const notifications = { sendOrderNoticePush: jest.fn() };
  const fcm = { sendToToken: jest.fn().mockResolvedValue('m1') };
  const events = { emit: jest.fn() };
  const svc = new RouteSheetNotifier(
    drivers as unknown as DriversGateway,
    admins as unknown as AdminGateway,
    customers as unknown as CustomersGateway,
    notifications as unknown as NotificationsService,
    fcm as unknown as FcmPort,
    events as unknown as EventEmitter2,
  );
  return { svc, drivers, admins, customers, notifications, fcm, events };
}

describe('RouteSheetNotifier', () => {
  it('hora argentina (UTC−3)', () => {
    expect(horaArgentina(Date.parse('2026-11-14T13:15:00Z'))).toBe('10:15');
  });

  it('al chofer por su sala; un socket caído no rompe', () => {
    const { svc, drivers } = armar();
    svc.alChofer('u1', 'route-sheet:started', { sheetId: 'h1' });
    expect(drivers.notifyRouteBatch).toHaveBeenCalledWith(
      'u1',
      'route-sheet:started',
      { sheetId: 'h1' },
    );
    drivers.notifyRouteBatch.mockImplementation(() => {
      throw new Error('caído');
    });
    expect(() =>
      svc.alChofer('u1', 'route-sheet:changed', { sheetId: 'h1' }),
    ).not.toThrow();
  });

  it('push al chofer sólo con token; un error no rompe', async () => {
    const { svc, fcm } = armar();
    const destino = { distributorId: 'd1', driverUserId: 'u1' };
    await svc.pushAlChofer(destino, null, 'h1', 'x');
    expect(fcm.sendToToken).not.toHaveBeenCalled();
    await svc.pushAlChofer(
      destino,
      'tok',
      'h1',
      'Se agregó una parada a tu hoja.',
    );
    expect(fcm.sendToToken).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({
        notification: {
          title: 'Tu hoja de ruta cambió',
          body: 'Se agregó una parada a tu hoja.',
        },
        data: { type: 'ROUTE_SHEET_CHANGED', sheetId: 'h1' },
      }),
      {
        type: 'ROUTE_SHEET_CHANGED',
        distributorId: 'd1',
        recipientUserId: 'u1',
      },
    );
    fcm.sendToToken.mockRejectedValueOnce(new Error('fcm'));
    await expect(
      svc.pushAlChofer(destino, 'tok', 'h1', 'x'),
    ).resolves.toBeUndefined();
  });

  it('al panel por la sala de la distribuidora', () => {
    const { svc, admins } = armar();
    svc.alPanel('d1', 'route-sheet:eta-updated', { sheetId: 'h1' });
    expect(admins.notifyAdmins).toHaveBeenCalledWith(
      'route-sheet:eta-updated',
      { sheetId: 'h1' },
      'd1',
    );
  });

  it('a la bandeja con su clave de deduplicación', () => {
    const { svc, events } = armar();
    svc.aLaBandeja('d1', {
      kind: 'route_sheet_stop_failed',
      title: 'T',
      body: 'B',
      dedupeKey: 'k1',
    });
    expect(events.emit).toHaveBeenCalledWith(
      EVENTO_NOTIFICAR_ADMIN,
      expect.objectContaining({
        distributorId: 'd1',
        kind: 'route_sheet_stop_failed',
        dedupeKey: 'k1',
      }),
    );
  });

  it('al cliente: socket con la franja y, si se pide, push en castellano con la hora argentina', async () => {
    const { svc, customers, notifications } = armar();
    const franja = {
      windowStartMs: Date.parse('2026-11-14T13:15:00Z'),
      windowEndMs: Date.parse('2026-11-14T14:15:00Z'),
      etaMs: Date.parse('2026-11-14T13:45:00Z'),
    };
    await svc.franjaAlCliente('c1', 'o1', franja, false);
    expect(customers.notifyCustomer).toHaveBeenCalledWith(
      'c1',
      'order:eta-updated',
      {
        orderId: 'o1',
        windowStart: '2026-11-14T13:15:00.000Z',
        windowEnd: '2026-11-14T14:15:00.000Z',
        etaAt: '2026-11-14T13:45:00.000Z',
      },
    );
    expect(notifications.sendOrderNoticePush).not.toHaveBeenCalled();
    await svc.franjaAlCliente('c1', 'o1', franja, true, 'd1');
    expect(notifications.sendOrderNoticePush).toHaveBeenCalledWith(
      'c1',
      'o1',
      {
        title: 'Horario estimado de tu pedido',
        body: 'Te llega entre las 10:15 y las 11:15.',
        event: 'ORDER_ETA_UPDATED',
      },
      undefined,
      'd1',
    );
  });

  it('push al chofer con título y tipo propios', async () => {
    const { svc, fcm } = armar();
    await svc.pushAlChofer(
      { distributorId: 'd1', driverUserId: 'u1' },
      'tok',
      'h1',
      'Tenés tu hoja',
      'Tu hoja de ruta de hoy',
      'ROUTE_SHEET_ASSIGNED',
    );
    expect(fcm.sendToToken).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({
        notification: {
          title: 'Tu hoja de ruta de hoy',
          body: 'Tenés tu hoja',
        },
        data: { type: 'ROUTE_SHEET_ASSIGNED', sheetId: 'h1' },
      }),
      {
        type: 'ROUTE_SHEET_ASSIGNED',
        distributorId: 'd1',
        recipientUserId: 'u1',
      },
    );
  });

  it('salida del viaje: socket con la franja y push «en camino» con la hora argentina', async () => {
    const { svc, customers, notifications } = armar();
    await svc.salidaAlCliente(
      'c1',
      'o1',
      {
        windowStartMs: Date.parse('2026-11-14T13:15:00Z'),
        windowEndMs: Date.parse('2026-11-14T14:15:00Z'),
        etaMs: Date.parse('2026-11-14T13:45:00Z'),
      },
      undefined,
      'd1',
    );
    expect(customers.notifyCustomer).toHaveBeenCalledWith(
      'c1',
      'order:eta-updated',
      expect.objectContaining({ orderId: 'o1' }),
    );
    expect(notifications.sendOrderNoticePush).toHaveBeenCalledWith(
      'c1',
      'o1',
      {
        title: 'Tu pedido está en camino',
        body: 'El chofer salió con tu pedido: te llega entre las 10:15 y las 11:15.',
        event: 'ORDER_TRIP_STARTED',
      },
      undefined,
      'd1',
    );
  });

  it('salida de un pedido en efectivo: el mismo push lleva el monto y la salida', async () => {
    const { svc, notifications } = armar();
    await svc.salidaAlCliente(
      'c1',
      'o1',
      {
        windowStartMs: Date.parse('2026-11-14T13:15:00Z'),
        windowEndMs: Date.parse('2026-11-14T14:15:00Z'),
        etaMs: Date.parse('2026-11-14T13:45:00Z'),
      },
      { monto: 12000, salida: 'd1:0' },
      'd1',
    );
    expect(notifications.sendOrderNoticePush).toHaveBeenCalledTimes(1);
    expect(notifications.sendOrderNoticePush).toHaveBeenCalledWith(
      'c1',
      'o1',
      expect.objectContaining({ event: 'ORDER_TRIP_STARTED' }),
      { monto: 12000, salida: 'd1:0' },
      'd1',
    );
  });

  it.each([
    [1, 'ORDER_DELIVERY_RETRY', 'Vuelve a pasar más tarde'],
    [2, 'ORDER_DELIVERY_FAILED', 'La distribuidora se va a comunicar'],
  ] as const)(
    'no entregado (intento %s): socket y push %s',
    async (intento, evento, texto) => {
      const { svc, customers, notifications } = armar();
      await svc.noEntregadoAlCliente('c1', 'o1', intento, 'd1');
      expect(customers.notifyCustomer).toHaveBeenCalledWith(
        'c1',
        'order:delivery-failed',
        { orderId: 'o1', attempt: intento },
      );
      expect(notifications.sendOrderNoticePush).toHaveBeenCalledWith(
        'c1',
        'o1',
        expect.objectContaining({
          event: evento,
          body: expect.stringContaining(texto) as string,
        }),
        undefined,
        'd1',
      );
    },
  );

  it('fecha legible y aviso de reprogramación al cliente', async () => {
    expect(diaLegible('2026-11-16')).toBe('lunes 16/11');
    expect(diaLegible('2026-11-15')).toBe('domingo 15/11');
    const { svc, customers, notifications } = armar();
    await svc.reprogramadoAlCliente('c1', 'o1', '2026-11-16', 'd1');
    expect(customers.notifyCustomer).toHaveBeenCalledWith(
      'c1',
      'order:rescheduled',
      {
        orderId: 'o1',
        scheduledDate: '2026-11-16',
      },
    );
    expect(notifications.sendOrderNoticePush).toHaveBeenCalledWith(
      'c1',
      'o1',
      {
        title: 'Reprogramamos tu pedido',
        body: 'No pudimos entregártelo hoy: lo reprogramamos para el lunes 16/11. Te avisamos el horario cuando se arme el recorrido de ese día.',
        event: 'ORDER_RESCHEDULED',
      },
      undefined,
      'd1',
    );
  });

  const FRANJA = {
    windowStartMs: Date.parse('2026-11-14T16:00:00Z'),
    windowEndMs: Date.parse('2026-11-14T17:00:00Z'),
    etaMs: Date.parse('2026-11-14T16:30:00Z'),
  };

  it('postergado (primer intento): socket con la franja nueva y push «más tarde» con la hora argentina', async () => {
    const { svc, customers, notifications } = armar();
    await svc.postergadoAlCliente('c1', 'o1', FRANJA, 'd1');
    const payload = {
      orderId: 'o1',
      windowStart: '2026-11-14T16:00:00.000Z',
      windowEnd: '2026-11-14T17:00:00.000Z',
      etaAt: '2026-11-14T16:30:00.000Z',
    };
    expect(customers.notifyCustomer).toHaveBeenCalledWith(
      'c1',
      'order:delivery-failed',
      { ...payload, attempt: 1 },
    );
    expect(customers.notifyCustomer).toHaveBeenCalledWith(
      'c1',
      'order:eta-updated',
      payload,
    );
    expect(notifications.sendOrderNoticePush).toHaveBeenCalledWith(
      'c1',
      'o1',
      {
        title: 'Reprogramamos tu pedido para más tarde',
        body: 'El chofer pasó y no pudo entregarlo. Vuelve a pasar hoy: te llega entre las 13:00 y las 14:00.',
        event: 'ORDER_DELIVERY_RETRY',
      },
      undefined,
      'd1',
    );
  });

  it('horario de un pedido sin franja fija al confirmarse la hoja: con el día y la franja', async () => {
    const { svc, customers, notifications } = armar();
    await svc.horarioAlCliente('c1', 'o1', '2026-11-16', FRANJA, 'd1');
    expect(customers.notifyCustomer).toHaveBeenCalledWith(
      'c1',
      'order:eta-updated',
      expect.objectContaining({ orderId: 'o1', scheduledDate: '2026-11-16' }),
    );
    expect(notifications.sendOrderNoticePush).toHaveBeenCalledWith(
      'c1',
      'o1',
      {
        title: 'Ya tenemos el horario de tu pedido',
        body: 'El lunes 16/11 te llega entre las 13:00 y las 14:00.',
        event: 'ORDER_ETA_UPDATED',
      },
      undefined,
      'd1',
    );
  });
});
