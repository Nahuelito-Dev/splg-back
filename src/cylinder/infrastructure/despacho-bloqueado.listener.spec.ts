import type { EventEmitter2 } from '@nestjs/event-emitter';
import {
  EVENTO_NOTIFICAR_ADMIN,
  NotificarAdminEvent,
} from '../../common/events/notificar-admin.event';
import { AdminGateway } from '../../gateways/admin.gateway';
import { DespachoBloqueadoEvent } from '../domain/events/despacho-bloqueado.event';
import { DespachoBloqueadoListener } from './despacho-bloqueado.listener';

describe('DespachoBloqueadoListener', () => {
  let events: { emit: jest.Mock };

  beforeEach(() => {
    events = { emit: jest.fn() };
  });

  function armar(admins: { notifyAdmins: jest.Mock }) {
    return new DespachoBloqueadoListener(
      admins as unknown as AdminGateway,
      events as unknown as EventEmitter2,
    );
  }

  it('un aviso que falla no tapa el rechazo del despacho', () => {
    const listener = armar({
      notifyAdmins: jest.fn(() => {
        throw new Error('socket caído');
      }),
    });

    expect(() =>
      listener.handle(new DespachoBloqueadoEvent('dist-1', null, ['SN-1'])),
    ).not.toThrow();
  });

  it('avisa a los administradores de la distribuidora con el pedido y los seriales', () => {
    const admins = { notifyAdmins: jest.fn() };
    const listener = armar(admins);

    listener.handle(new DespachoBloqueadoEvent('dist-1', 'ord-1', ['SN-1']));

    expect(admins.notifyAdmins).toHaveBeenCalledWith(
      'cylinder:dispatch-blocked',
      { orderId: 'ord-1', distributorId: 'dist-1', serials: ['SN-1'] },
      'dist-1',
    );
  });

  it('pide el aviso de la bandeja con los seriales ordenados en la clave', () => {
    armar({ notifyAdmins: jest.fn() }).handle(
      new DespachoBloqueadoEvent('dist-1', 'ord-1', ['SN-2', 'SN-1']),
    );

    expect(events.emit).toHaveBeenCalledWith(
      EVENTO_NOTIFICAR_ADMIN,
      expect.objectContaining<Partial<NotificarAdminEvent>>({
        distributorId: 'dist-1',
        kind: 'cylinder_dispatch_blocked',
        dedupeKey: 'cylinder-blocked:ord-1:SN-1,SN-2',
        link: { entity: 'order', id: 'ord-1' },
        email: false,
      }),
    );
  });

  it('sin pedido, la clave dice «suelto» y el aviso no lleva destino', () => {
    armar({ notifyAdmins: jest.fn() }).handle(
      new DespachoBloqueadoEvent('dist-1', null, ['SN-1']),
    );

    expect(events.emit).toHaveBeenCalledWith(
      EVENTO_NOTIFICAR_ADMIN,
      expect.objectContaining<Partial<NotificarAdminEvent>>({
        dedupeKey: 'cylinder-blocked:suelto:SN-1',
        link: null,
      }),
    );
  });

  it('con tantos seriales que no entra en la columna, la clave usa un hash y no pasa de 200', () => {
    const seriales = Array.from({ length: 60 }, (_, i) => `SERIE-${i}-LARGA`);
    armar({ notifyAdmins: jest.fn() }).handle(
      new DespachoBloqueadoEvent('dist-1', 'ord-1', seriales),
    );

    const [, evento] = events.emit.mock.calls[0] as [
      string,
      NotificarAdminEvent,
    ];
    expect(evento.dedupeKey.length).toBeLessThanOrEqual(200);
    expect(evento.dedupeKey).toMatch(/^cylinder-blocked:ord-1:[0-9a-f]{40}$/);
  });

  it('si no se puede pedir el aviso de la bandeja, el despacho rechazado sigue', () => {
    events.emit.mockImplementation(() => {
      throw new Error('bus roto');
    });

    expect(() =>
      armar({ notifyAdmins: jest.fn() }).handle(
        new DespachoBloqueadoEvent('dist-1', 'ord-1', ['SN-1']),
      ),
    ).not.toThrow();
  });
});
