import { AdminGateway } from './admin.gateway';

describe('AdminGateway — sala de la flota', () => {
  it('sólo quien tiene flota.ver entra a la sala de la flota de su empresa', () => {
    expect(AdminGateway.salasDeListas('d1', ['flota.ver'])).toContain(
      'flota:d1',
    );
    expect(
      AdminGateway.salasDeListas('d1', ['mensajes.clientes', 'pedidos.ver']),
    ).not.toContain('flota:d1');
  });

  it('el aviso del tablero va a la sala de la flota de esa empresa', () => {
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const gateway = Object.create(AdminGateway.prototype) as AdminGateway;
    (gateway as unknown as { server: unknown }).server = { to };

    gateway.emitirALaFlota('d1', 'fleet:task', { id: 't1' });

    expect(to).toHaveBeenCalledWith('flota:d1');
    expect(emit).toHaveBeenCalledWith('fleet:task', { id: 't1' });
  });
});
