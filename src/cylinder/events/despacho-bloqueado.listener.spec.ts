import { AdminGateway } from '../../gateways/admin.gateway';
import { DespachoBloqueadoEvent } from './despacho-bloqueado.event';
import { DespachoBloqueadoListener } from './despacho-bloqueado.listener';

describe('DespachoBloqueadoListener', () => {
  it('un aviso que falla no tapa el rechazo del despacho', () => {
    const admins = {
      notifyAdmins: jest.fn(() => {
        throw new Error('socket caído');
      }),
    };
    const listener = new DespachoBloqueadoListener(
      admins as unknown as AdminGateway,
    );

    expect(() =>
      listener.handle(new DespachoBloqueadoEvent('dist-1', null, ['SN-1'])),
    ).not.toThrow();
  });

  it('avisa a los administradores de la distribuidora con el pedido y los seriales', () => {
    const admins = { notifyAdmins: jest.fn() };
    const listener = new DespachoBloqueadoListener(
      admins as unknown as AdminGateway,
    );

    listener.handle(new DespachoBloqueadoEvent('dist-1', 'ord-1', ['SN-1']));

    expect(admins.notifyAdmins).toHaveBeenCalledWith(
      'cylinder:dispatch-blocked',
      { orderId: 'ord-1', distributorId: 'dist-1', serials: ['SN-1'] },
      'dist-1',
    );
  });
});
