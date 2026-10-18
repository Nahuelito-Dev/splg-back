import { DriversGateway } from './drivers.gateway';

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

  it('la cancelación va a la misma sala como order:cancelled', () => {
    gateway.notifyOrderCancelled('u-chofer', { orderId: 'o1' });
    expect(to).toHaveBeenCalledWith('driver_u-chofer');
    expect(emit).toHaveBeenCalledWith('order:cancelled', { orderId: 'o1' });
  });
});
