import type { EventEmitter2 } from '@nestjs/event-emitter';
import { EVENTO_NOTIFICAR_ADMIN } from '../common/events/notificar-admin.event';
import { Delivery } from '../delivery/entities/delivery.entity';
import { FcmPort } from '../firebase/ports/fcm.port';
import { DriversGateway } from '../gateways/drivers.gateway';
import { RouteBatchNotifier } from './route-batch.notifier';

const oferta = {
  batchId: 'b1',
  offerId: 'o1',
  expiresAt: new Date('2026-11-01T12:01:00Z'),
  totalWeightKg: 25,
  stopCount: 2,
};

describe('RouteBatchNotifier', () => {
  let drivers: { notifyRouteBatch: jest.Mock };
  let fcm: { sendToToken: jest.Mock };
  let events: { emit: jest.Mock };
  let notifier: RouteBatchNotifier;
  const delivery = (token: string | undefined) =>
    ({ userId: 'u1', notificationToken: token }) as Delivery;

  beforeEach(() => {
    drivers = { notifyRouteBatch: jest.fn() };
    fcm = { sendToToken: jest.fn().mockResolvedValue('msg') };
    events = { emit: jest.fn() };
    notifier = new RouteBatchNotifier(
      drivers as unknown as DriversGateway,
      fcm as unknown as FcmPort,
      events as unknown as EventEmitter2,
    );
  });

  it('la oferta le llega al chofer por socket con lo que necesita para decidir', async () => {
    await notifier.ofertaAlChofer(delivery(undefined), oferta);

    expect(drivers.notifyRouteBatch).toHaveBeenCalledWith(
      'u1',
      'route-batch:offer',
      {
        batchId: 'b1',
        offerId: 'o1',
        expiresAt: '2026-11-01T12:01:00.000Z',
        totalWeightKg: 25,
        stopCount: 2,
      },
    );
    expect(fcm.sendToToken).not.toHaveBeenCalled();
  });

  it('con token también va por push, con el lote en los datos', async () => {
    await notifier.ofertaAlChofer(delivery('tok'), oferta);

    expect(fcm.sendToToken).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({
        data: { type: 'ROUTE_BATCH_OFFER', batchId: 'b1' },
      }),
    );
  });

  it('un push que falla no tira la oferta', async () => {
    fcm.sendToToken.mockRejectedValue(new Error('fcm caído'));

    await expect(
      notifier.ofertaAlChofer(delivery('tok'), oferta),
    ).resolves.toBeUndefined();
    expect(drivers.notifyRouteBatch).toHaveBeenCalledTimes(1);
  });

  it('un socket que falla no tira la oferta', async () => {
    drivers.notifyRouteBatch.mockImplementation(() => {
      throw new Error('socket caído');
    });

    await expect(
      notifier.ofertaAlChofer(delivery('tok'), oferta),
    ).resolves.toBeUndefined();
    expect(fcm.sendToToken).toHaveBeenCalledTimes(1);
  });

  it('avisa al chofer que la oferta se cerró y por qué', () => {
    notifier.ofertaCerrada('u1', 'b1', 'expired');

    expect(drivers.notifyRouteBatch).toHaveBeenCalledWith(
      'u1',
      'route-batch:offer-closed',
      { batchId: 'b1', reason: 'expired' },
    );
  });

  it('avisa al chofer los pedidos que quedaron asignados', () => {
    notifier.loteAsignado('u1', 'b1', ['p1', 'p2']);

    expect(drivers.notifyRouteBatch).toHaveBeenCalledWith(
      'u1',
      'route-batch:assigned',
      { batchId: 'b1', orderIds: ['p1', 'p2'] },
    );
  });

  it('un lote sin chofer deja un aviso al administrador, una vez por lote', () => {
    notifier.loteSinChofer('d1', 'b1', 3);

    const [evento, aviso] = events.emit.mock.calls[0] as [
      string,
      { distributorId: string; dedupeKey: string; body: string },
    ];
    expect(evento).toBe(EVENTO_NOTIFICAR_ADMIN);
    expect(aviso.distributorId).toBe('d1');
    expect(aviso.dedupeKey).toBe('route-batch-exhausted:b1');
    expect(aviso.body).toContain('3 pedidos');
  });
});
