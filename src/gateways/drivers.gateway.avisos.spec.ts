import { DriversGateway, EVENTO_POSICION_DEL_CHOFER } from './drivers.gateway';

/** Avisos al chofer: van a su sala por id de usuario, con el evento que la app escucha. */
describe('DriversGateway · avisos de pedido', () => {
  let emit: jest.Mock;
  let to: jest.Mock;
  let gateway: DriversGateway;

  beforeEach(() => {
    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });
    gateway = new DriversGateway(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    gateway.server = { to } as never;
  });

  it('el cambio de dirección va a la sala del chofer como order:address-changed', () => {
    const payload = { orderId: 'o1', toAddressId: 'a2' };
    gateway.notifyOrderAddressChanged('u-chofer', payload);
    expect(to).toHaveBeenCalledWith('driver_u-chofer');
    expect(emit).toHaveBeenCalledWith('order:address-changed', payload);
  });

  it.each([
    'order:delivery-code-failed',
    'order:delivery-code-blocked',
  ] as const)('%s va a la sala del chofer', (evento) => {
    const payload = { orderId: 'o1', attempts: 5, blocked: true };
    gateway.notifyDeliveryCode('u-chofer', evento, payload);
    expect(to).toHaveBeenCalledWith('driver_u-chofer');
    expect(emit).toHaveBeenCalledWith(evento, payload);
  });

  it('la sala del aviso es la misma a la que se une el chofer con driver:join', async () => {
    const join = jest.fn();
    const identidades = {
      obtener: jest.fn().mockResolvedValue({ userId: 'u-chofer' }),
    };
    const g = new DriversGateway(
      {} as never,
      identidades as never,
      {} as never,
      {} as never,
    );
    await g.handleDriverJoin(null, {
      join,
      data: {},
      emit: jest.fn(),
    } as never);
    g.server = { to } as never;
    g.notifyDeliveryCode('u-chofer', 'order:delivery-code-blocked', {});
    const sala = (join.mock.calls as string[][])[0][0];
    expect(to).toHaveBeenCalledWith(sala);
  });

  it('la cancelación va a la misma sala como order:cancelled', () => {
    gateway.notifyOrderCancelled('u-chofer', { orderId: 'o1' });
    expect(to).toHaveBeenCalledWith('driver_u-chofer');
    expect(emit).toHaveBeenCalledWith('order:cancelled', { orderId: 'o1' });
  });

  it('cada posición del chofer se emite (la hoja de ruta recalcula su hora estimada) con la identidad del token', async () => {
    const events = { emit: jest.fn() };
    const redis = {
      updateDriverLocation: jest.fn().mockResolvedValue(undefined),
      getDriverActiveOrder: jest.fn().mockResolvedValue(null),
    };
    const g = new DriversGateway(
      redis as never,
      { obtener: jest.fn().mockResolvedValue({ userId: 'u-chofer' }) } as never,
      {} as never,
      {} as never,
      events as never,
    );
    await g.handleDriverLocation({ lat: -27.4, lng: -55.9 }, {
      data: {},
      disconnect: jest.fn(),
    } as never);
    expect(events.emit).toHaveBeenCalledWith(EVENTO_POSICION_DEL_CHOFER, {
      userId: 'u-chofer',
      lat: -27.4,
      lng: -55.9,
    });
    // Sin emisor (como en los tests viejos) sigue andando.
    const sinEventos = new DriversGateway(
      redis as never,
      { obtener: jest.fn().mockResolvedValue({ userId: 'u' }) } as never,
      {} as never,
      {} as never,
    );
    await expect(
      sinEventos.handleDriverLocation({ lat: 0, lng: 0 }, {
        data: {},
        disconnect: jest.fn(),
      } as never),
    ).resolves.toBeUndefined();
  });

  it('los eventos de la hoja de ruta van a la sala del chofer', () => {
    gateway.notifyRouteBatch('u-chofer', 'route-sheet:changed', {
      sheetId: 'h1',
    });
    expect(to).toHaveBeenCalledWith('driver_u-chofer');
    expect(emit).toHaveBeenCalledWith('route-sheet:changed', { sheetId: 'h1' });
  });
});
