import { RealtimeDispatchAdapter } from './realtime-dispatch.adapter';

describe('RealtimeDispatchAdapter.lastDriverLocation', () => {
  const POSICION = { lat: -34.6, lng: -58.4, at: '2026-10-12T20:15:00.000Z' };
  let redis: {
    getDriverActiveOrder: jest.Mock;
    getDriverLastLocation: jest.Mock;
  };
  let adapter: RealtimeDispatchAdapter;

  beforeEach(() => {
    redis = {
      getDriverActiveOrder: jest.fn(),
      getDriverLastLocation: jest.fn().mockResolvedValue(POSICION),
    };
    adapter = new RealtimeDispatchAdapter(
      redis as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('devuelve la posición cuando el pedido es el que el chofer lleva', async () => {
    redis.getDriverActiveOrder.mockResolvedValue({ orderId: 'o1' });
    await expect(adapter.lastDriverLocation('u1', 'o1')).resolves.toEqual(
      POSICION,
    );
  });

  it('si el chofer lleva OTRO pedido, no se la da al cliente de éste', async () => {
    redis.getDriverActiveOrder.mockResolvedValue({ orderId: 'o2' });
    await expect(adapter.lastDriverLocation('u1', 'o1')).resolves.toBeNull();
    expect(redis.getDriverLastLocation).not.toHaveBeenCalled();
  });

  it('si no tiene pedido activo, tampoco', async () => {
    redis.getDriverActiveOrder.mockResolvedValue(null);
    await expect(adapter.lastDriverLocation('u1', 'o1')).resolves.toBeNull();
  });
});

describe('RealtimeDispatchAdapter.notifyDriverOrderAddressChanged', () => {
  it('delega el aviso en el gateway de choferes con el id de usuario', () => {
    const notifyOrderAddressChanged = jest.fn();
    const adapter = new RealtimeDispatchAdapter(
      {} as never,
      { notifyOrderAddressChanged } as never,
      {} as never,
      {} as never,
    );
    adapter.notifyDriverOrderAddressChanged('u1', { orderId: 'o1' });
    expect(notifyOrderAddressChanged).toHaveBeenCalledWith('u1', {
      orderId: 'o1',
    });
  });
});

describe('RealtimeDispatchAdapter.notifyDriverDeliveryCode', () => {
  it('delega en el gateway de choferes con el evento y el id de usuario', () => {
    const notifyDeliveryCode = jest.fn();
    const adapter = new RealtimeDispatchAdapter(
      {} as never,
      { notifyDeliveryCode } as never,
      {} as never,
      {} as never,
    );
    adapter.notifyDriverDeliveryCode('u1', 'order:delivery-code-failed', {
      orderId: 'o1',
    });
    expect(notifyDeliveryCode).toHaveBeenCalledWith(
      'u1',
      'order:delivery-code-failed',
      { orderId: 'o1' },
    );
  });
});
