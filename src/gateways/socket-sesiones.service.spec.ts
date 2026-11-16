import type { Namespace } from 'socket.io';
import { SocketSesionesService } from './socket-sesiones.service';
import type { AdminGateway } from './admin.gateway';
import type { CustomersGateway } from './customers.gateway';
import type { DriversGateway } from './drivers.gateway';
import { AccesoRevocadoEvent } from '../common/events/acceso-revocado.event';

/**
 * La identidad del socket se resuelve una vez; esto la mantiene vigente: corta
 * las conexiones con el token vencido y, en el momento, las de un usuario
 * bloqueado o dado de baja.
 */
describe('SocketSesionesService', () => {
  const AHORA = 1_800_000_000_000;

  const socket = (expiraEn: number | null | undefined) => ({
    data: expiraEn === undefined ? {} : { identidad: { expiraEn } },
    emit: jest.fn(),
    disconnect: jest.fn(),
  });

  const espacio = (sockets: ReturnType<typeof socket>[]) => {
    const sala = { emit: jest.fn(), disconnectSockets: jest.fn() };
    return {
      sockets: new Map(sockets.map((s, i) => [String(i), s])),
      to: jest.fn(() => sala),
      in: jest.fn(() => sala),
      sala,
    };
  };

  const armar = (
    admin: ReturnType<typeof espacio>,
    clientes: ReturnType<typeof espacio>,
    choferes: ReturnType<typeof espacio>,
  ) =>
    new SocketSesionesService(
      { server: admin as unknown as Namespace } as AdminGateway,
      { server: clientes as unknown as Namespace } as CustomersGateway,
      { server: choferes as unknown as Namespace } as DriversGateway,
    );

  it('corta sólo las conexiones con el token vencido, avisando antes', () => {
    const vencido = socket(AHORA - 1);
    const justo = socket(AHORA);
    const vigente = socket(AHORA + 60_000);
    const sinVencimiento = socket(null);
    const sinIdentidad = socket(undefined);
    const service = armar(
      espacio([vencido, vigente]),
      espacio([justo, sinVencimiento]),
      espacio([sinIdentidad]),
    );

    expect(service.cortarSesionesVencidas(AHORA)).toBe(2);

    for (const s of [vencido, justo]) {
      expect(s.emit).toHaveBeenCalledWith(
        'server:session-expired',
        expect.anything(),
      );
      expect(s.disconnect).toHaveBeenCalled();
    }
    for (const s of [vigente, sinVencimiento, sinIdentidad]) {
      expect(s.emit).not.toHaveBeenCalled();
      expect(s.disconnect).not.toHaveBeenCalled();
    }
  });

  it('sin servidor de sockets (seed, CLI) no hace nada', () => {
    const service = new SocketSesionesService(
      {} as AdminGateway,
      {} as CustomersGateway,
      {} as DriversGateway,
    );
    expect(service.cortarSesionesVencidas(AHORA)).toBe(0);
    expect(() =>
      service.revocar(new AccesoRevocadoEvent('u-1', 'baja')),
    ).not.toThrow();
  });

  it('al revocar el acceso corta la sala del usuario en los tres namespaces', () => {
    const espacios = [espacio([]), espacio([]), espacio([])] as const;
    const service = armar(...espacios);

    service.revocar(new AccesoRevocadoEvent('u-1', 'bloqueo'));

    for (const e of espacios) {
      expect(e.to).toHaveBeenCalledWith('usuario:u-1');
      expect(e.in).toHaveBeenCalledWith('usuario:u-1');
      expect(e.sala.emit).toHaveBeenCalledWith('server:access-revoked', {
        motivo: 'bloqueo',
      });
      expect(e.sala.disconnectSockets).toHaveBeenCalled();
    }
  });
});
