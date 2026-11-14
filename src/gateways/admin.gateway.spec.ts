import { AdminGateway } from './admin.gateway';
import { SocketIdentityService } from './socket-identity.service';
import { SocketDeSplg } from './socket-data';
import { RoleType } from '../common/constants/role-type.enum';

/**
 * Aislamiento del panel en tiempo real por distribuidora (punto 7 de la
 * revisión, mismo espíritu que H-77..H-84 en HTTP): un admin de empresa sólo
 * recibe los eventos DE SU distribuidora; el super admin ve todas. El join lo
 * decide el SERVIDOR a partir de la identidad del token, nunca el cliente.
 */
describe('AdminGateway', () => {
  let gateway: AdminGateway;
  let identidades: { identificar: jest.Mock };
  let server: { to: jest.Mock };
  let emit: jest.Mock;

  // Tipado como objeto plano (no `SocketDeSplg`) para que los `expect(c.join)
  // .toHaveBeenCalled()` de abajo no disparen `unbound-method`: son jest.fn(),
  // no métodos reales de una clase. El cast a `SocketDeSplg` sólo se hace al
  // pasarlo al gateway, donde importa el tipo.
  const client = () => ({
    id: 'sock-1',
    join: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn(),
    disconnect: jest.fn(),
  });

  beforeEach(() => {
    identidades = { identificar: jest.fn() };
    emit = jest.fn();
    server = { to: jest.fn(() => ({ emit })) };

    gateway = new AdminGateway(identidades as unknown as SocketIdentityService);
    gateway.server = server as unknown as import('socket.io').Namespace;
  });

  describe('handleConnection', () => {
    it('rechaza sin identidad', async () => {
      identidades.identificar.mockResolvedValue(null);
      const c = client();
      await gateway.handleConnection(c as unknown as SocketDeSplg);
      expect(c.disconnect).toHaveBeenCalled();
      expect(c.join).not.toHaveBeenCalled();
    });

    it('rechaza a un customer/delivery (no es rol del panel)', async () => {
      identidades.identificar.mockResolvedValue({
        userId: 'u1',
        email: 'chofer@splg.com',
        role: RoleType.DELIVERY,
        distributorId: 'dist-1',
      });
      const c = client();
      await gateway.handleConnection(c as unknown as SocketDeSplg);
      expect(c.disconnect).toHaveBeenCalled();
    });

    it('un admin de empresa se une a la sala DE SU distribuidora', async () => {
      identidades.identificar.mockResolvedValue({
        userId: 'u1',
        email: 'admin@splg.com',
        role: RoleType.ADMIN,
        distributorId: 'dist-1',
      });
      const c = client();
      await gateway.handleConnection(c as unknown as SocketDeSplg);
      expect(c.join).toHaveBeenCalledWith('admins:dist-1');
      expect(c.disconnect).not.toHaveBeenCalled();
    });

    it('el super_admin entra sólo a la sala de plataforma (nunca a la de una empresa)', async () => {
      identidades.identificar.mockResolvedValue({
        userId: 'u2',
        email: 'super@splg.com',
        role: RoleType.SUPER_ADMIN,
        distributorId: null,
      });
      const c = client();
      await gateway.handleConnection(c as unknown as SocketDeSplg);
      const salas = (c.join.mock.calls as string[][]).map(([sala]) => sala);
      expect(salas.sort()).toEqual(['platform', 'usuario:u2']);
    });

    it('un admin con perfil inconsistente (sin distributorId) se rechaza, igual que el guard HTTP (punto 4 de la 2da revisión)', async () => {
      identidades.identificar.mockResolvedValue({
        userId: 'u3',
        email: 'admin-roto@splg.com',
        role: RoleType.ADMIN,
        distributorId: null,
      });
      const c = client();
      await gateway.handleConnection(c as unknown as SocketDeSplg);
      expect(c.disconnect).toHaveBeenCalled();
      expect(c.join).not.toHaveBeenCalled();
    });
  });

  describe('notifyAdmins', () => {
    it('con distributorId, emite SÓLO a la sala de esa distribuidora (el super admin no la recibe)', () => {
      gateway.notifyAdmins('order:created', { orderId: 'o1' }, 'dist-1');

      expect(server.to.mock.calls).toEqual([['admins:dist-1']]);
      expect(emit).toHaveBeenCalledWith('order:created', { orderId: 'o1' });
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('sin distributorId, es un evento de plataforma: sala platform', () => {
      gateway.notifyAdmins('process:failed', { process: 'x' });

      expect(server.to.mock.calls).toEqual([['platform']]);
    });
  });

  describe('modo soporte', () => {
    it('notifyPlatform llega sólo a la sala platform', () => {
      gateway.notifyPlatform('support:approved', { id: 's1' });
      expect(server.to.mock.calls).toEqual([['platform']]);
      expect(emit).toHaveBeenCalledWith('support:approved', { id: 's1' });
    });

    it('el fin de la sesión de soporte va a la sala personal del super admin', () => {
      gateway.avisarFinDeSoporte('u2', {
        sessionId: 's1',
        status: 'revoked',
        endReason: 'revoked_by_company',
      });
      expect(server.to.mock.calls).toEqual([['usuario:u2']]);
      expect(emit).toHaveBeenCalledWith('support:ended', {
        sessionId: 's1',
        status: 'revoked',
        endReason: 'revoked_by_company',
      });
    });
  });
});
