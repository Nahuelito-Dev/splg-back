import {
  AdminGateway,
  EVENTO_ESCRIBIENDO_DEL_PANEL,
  EVENTO_SOPORTE_CONECTADO,
  EVENTO_SOPORTE_DESCONECTADO,
} from './admin.gateway';
import type { StaffPermissionsService } from '../admin/staff-permissions.service';
import type { PermisosDePlataformaService } from '../common/permisos/catalogo-de-plataforma';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { ParticipacionEnConversaciones } from './participacion-en-conversaciones.service';
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
  let identidades: { identificar: jest.Mock; obtener: jest.Mock };
  let permisos: { deUsuario: jest.Mock };
  let permisosDePlataforma: { deUsuario: jest.Mock };
  let events: { emit: jest.Mock };
  let participacion: { deConversacion: jest.Mock };
  let server: { to: jest.Mock };
  let emit: jest.Mock;

  // Tipado como objeto plano (no `SocketDeSplg`) para que los `expect(c.join)
  // .toHaveBeenCalled()` de abajo no disparen `unbound-method`: son jest.fn(),
  // no métodos reales de una clase. El cast a `SocketDeSplg` sólo se hace al
  // pasarlo al gateway, donde importa el tipo.
  const client = () => {
    const rooms = new Set<string>();
    return {
      id: 'sock-1',
      rooms,
      data: {},
      join: jest.fn((sala: string) => {
        rooms.add(sala);
        return Promise.resolve();
      }),
      leave: jest.fn((sala: string) => {
        rooms.delete(sala);
        return Promise.resolve();
      }),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
  };

  beforeEach(() => {
    identidades = { identificar: jest.fn(), obtener: jest.fn() };
    permisos = {
      deUsuario: jest
        .fn()
        .mockResolvedValue({ permisos: ['soporte.ver', 'soporte.gestionar'] }),
    };
    permisosDePlataforma = {
      deUsuario: jest.fn().mockResolvedValue(['plataforma.tickets.ver']),
    };
    events = { emit: jest.fn() };
    participacion = {
      deConversacion: jest.fn().mockResolvedValue({
        distributorId: 'dist-1',
        channel: 'platform_chat',
      }),
    };
    emit = jest.fn();
    server = { to: jest.fn(() => ({ emit })) };

    gateway = new AdminGateway(
      identidades as unknown as SocketIdentityService,
      permisos as unknown as StaffPermissionsService,
      permisosDePlataforma as unknown as PermisosDePlataformaService,
      events as unknown as EventEmitter2,
      participacion as unknown as ParticipacionEnConversaciones,
    );
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
      expect(salas.sort()).toEqual([
        'chat:plataforma',
        'platform',
        'usuario:u2',
      ]);
    });

    it('el super admin sin `plataforma.tickets.ver` no entra a la sala del chat con las empresas', async () => {
      permisosDePlataforma.deUsuario.mockResolvedValue([]);
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

    it('si no se pueden leer los permisos de plataforma, falla cerrado: no entra a la sala del chat', async () => {
      permisosDePlataforma.deUsuario.mockRejectedValue(new Error('caído'));
      identidades.identificar.mockResolvedValue({
        userId: 'u2',
        email: 'super@splg.com',
        role: RoleType.SUPER_ADMIN,
        distributorId: null,
      });
      const c = client();
      await gateway.handleConnection(c as unknown as SocketDeSplg);
      const salas = (c.join.mock.calls as string[][]).map(([sala]) => sala);
      expect(salas).not.toContain('chat:plataforma');
    });

    it('el admin con `soporte.ver` entra a la sala de soporte de SU empresa; sin el permiso, no', async () => {
      const admin = {
        userId: 'u1',
        email: 'admin@splg.com',
        role: RoleType.ADMIN,
        distributorId: 'dist-1',
      };
      identidades.identificar.mockResolvedValue(admin);
      const con = client();
      await gateway.handleConnection(con as unknown as SocketDeSplg);
      permisos.deUsuario.mockResolvedValue({ permisos: ['pedidos.ver'] });
      const sin = client();
      await gateway.handleConnection(sin as unknown as SocketDeSplg);
      const salas = (c: ReturnType<typeof client>) =>
        (c.join.mock.calls as string[][]).map(([sala]) => sala).sort();
      expect({ con: salas(con), sin: salas(sin) }).toEqual({
        con: ['admins:dist-1', 'chat:soporte:dist-1', 'usuario:u1'],
        sin: ['admins:dist-1', 'usuario:u1'],
      });
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

    it('los eventos del chat van a la sala de soporte de esa empresa o a la de la plataforma', () => {
      gateway.emitirAlSoporteDeEmpresa('dist-1', 'chat:message', { seq: 1 });
      gateway.emitirAlSoporteDePlataforma('chat:message', { seq: 1 });
      gateway.emitirAUsuario('u1', 'chat:read', { seq: 1 });
      expect(server.to.mock.calls).toEqual([
        ['chat:soporte:dist-1'],
        ['chat:plataforma'],
        ['usuario:u1'],
      ]);
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

  describe('chat:typing', () => {
    const conv = '7d1f3a52-6c2b-4c1e-9d55-2f0b8f1a9e10';
    /** Una conexión que ya entró a la sala de la conversación (las dos mitades). */
    const unido = () => {
      const c = client();
      c.rooms.add(`conv:${conv}:platform`);
      c.rooms.add(`conv:${conv}:company`);
      return c;
    };
    const superAdmin = {
      userId: 'u2',
      email: 'super@splg.com',
      role: RoleType.SUPER_ADMIN,
      distributorId: null,
    };

    it('reenvía al chat el pedido del super admin con el permiso', async () => {
      identidades.obtener.mockResolvedValue(superAdmin);
      const c = unido();
      await gateway.handleTyping(
        { conversationId: conv },
        c as unknown as SocketDeSplg,
      );
      expect(events.emit).toHaveBeenCalledWith(EVENTO_ESCRIBIENDO_DEL_PANEL, {
        conversationId: conv,
        userId: 'u2',
        distributorId: null,
        esPlataforma: true,
        internal: false,
      });
    });

    it('el super admin sin `plataforma.tickets.ver` (o si el chequeo falla) no emite nada', async () => {
      identidades.obtener.mockResolvedValue(superAdmin);
      permisosDePlataforma.deUsuario.mockResolvedValueOnce([]);
      await gateway.handleTyping(
        { conversationId: conv },
        unido() as unknown as SocketDeSplg,
      );
      permisosDePlataforma.deUsuario.mockRejectedValueOnce(new Error('caído'));
      await gateway.handleTyping(
        { conversationId: conv },
        unido() as unknown as SocketDeSplg,
      );
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('B1: el admin sin `soporte.gestionar` (o si el chequeo falla) no «escribe»', async () => {
      identidades.obtener.mockResolvedValue({
        userId: 'u1',
        email: 'admin@splg.com',
        role: RoleType.ADMIN,
        distributorId: 'dist-1',
      });
      permisos.deUsuario.mockResolvedValueOnce({ permisos: ['soporte.ver'] });
      await gateway.handleTyping(
        { conversationId: conv },
        unido() as unknown as SocketDeSplg,
      );
      permisos.deUsuario.mockRejectedValueOnce(new Error('caído'));
      await gateway.handleTyping(
        { conversationId: conv },
        unido() as unknown as SocketDeSplg,
      );
      expect(events.emit).not.toHaveBeenCalled();
      await gateway.handleTyping(
        { conversationId: conv },
        unido() as unknown as SocketDeSplg,
      );
      expect(events.emit).toHaveBeenCalledTimes(1);
    });

    it('D-C28: sin haber entrado a la sala de la conversación no «escribe»', async () => {
      identidades.obtener.mockResolvedValue(superAdmin);
      await gateway.handleTyping(
        { conversationId: conv },
        client() as unknown as SocketDeSplg,
      );
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('ignora un id mal formado y más de un pedido cada 3 segundos', async () => {
      identidades.obtener.mockResolvedValue({
        userId: 'u1',
        email: 'admin@splg.com',
        role: RoleType.ADMIN,
        distributorId: 'dist-1',
      });
      const c = unido() as unknown as SocketDeSplg;
      await gateway.handleTyping({ conversationId: 'x' }, c);
      await gateway.handleTyping({ conversationId: conv }, c);
      await gateway.handleTyping({ conversationId: conv }, c);
      expect(events.emit).toHaveBeenCalledTimes(1);
    });
  });

  describe('chat:join (D-C28: una sala por conversación)', () => {
    const conv = '7d1f3a52-6c2b-4c1e-9d55-2f0b8f1a9e10';
    const admin = {
      userId: 'u1',
      email: 'admin@splg.com',
      role: RoleType.ADMIN,
      distributorId: 'dist-1',
    };
    const superAdmin = {
      userId: 'u2',
      email: 'super@splg.com',
      role: RoleType.SUPER_ADMIN,
      distributorId: null,
    };
    const unirse = async (identidad: unknown) => {
      identidades.obtener.mockResolvedValue(identidad);
      const c = client();
      const r = await gateway.handleJoin(
        { conversationId: conv },
        c as unknown as SocketDeSplg,
      );
      return { r, salas: [...c.rooms] };
    };

    it('el admin de la empresa entra a su mitad; el super admin, a la suya', async () => {
      expect([await unirse(admin), await unirse(superAdmin)]).toEqual([
        { r: { ok: true }, salas: [`conv:${conv}:company`] },
        { r: { ok: true }, salas: [`conv:${conv}:platform`] },
      ]);
    });

    it('la conversación de otra empresa da error y no se une', async () => {
      participacion.deConversacion.mockResolvedValue({
        distributorId: 'dist-2',
        channel: 'platform_chat',
      });
      expect(await unirse(admin)).toEqual({
        r: {
          ok: false,
          code: 'CHAT_JOIN_DENIED',
          message: 'No existe esa conversación',
        },
        salas: [],
      });
    });

    it('inexistente, de un canal sin sala o sin permiso: error (y si el chequeo falla, también)', async () => {
      participacion.deConversacion.mockResolvedValueOnce(null);
      const inexistente = await unirse(admin);
      participacion.deConversacion.mockResolvedValueOnce({
        distributorId: 'dist-1',
        channel: 'staff_customer',
      });
      const otroCanal = await unirse(admin);
      permisos.deUsuario.mockResolvedValueOnce({ permisos: ['pedidos.ver'] });
      const sinPermiso = await unirse(admin);
      permisosDePlataforma.deUsuario.mockResolvedValueOnce([]);
      const superSinPermiso = await unirse(superAdmin);
      participacion.deConversacion.mockRejectedValueOnce(new Error('caída'));
      const falla = await unirse(admin);
      expect(
        [inexistente, otroCanal, sinPermiso, superSinPermiso, falla].map(
          (x) => [x.r.ok, x.salas.length],
        ),
      ).toEqual(Array(5).fill([false, 0]));
    });

    it('un id mal formado da error; salir deja las dos mitades', async () => {
      identidades.obtener.mockResolvedValue(admin);
      const c = client();
      const malo = await gateway.handleJoin(
        { conversationId: 'x' },
        c as unknown as SocketDeSplg,
      );
      await gateway.handleJoin(
        { conversationId: conv },
        c as unknown as SocketDeSplg,
      );
      await gateway.handleLeave(
        { conversationId: conv },
        c as unknown as SocketDeSplg,
      );
      expect({ malo: malo.ok, salas: [...c.rooms] }).toEqual({
        malo: false,
        salas: [],
      });
    });

    it('los eventos de una conversación van sólo a su sala, a la mitad de esa punta', () => {
      gateway.emitirAConversacion(conv, 'company', 'chat:message', { seq: 1 });
      expect(server.to.mock.calls).toEqual([[`conv:${conv}:company`]]);
    });
  });

  describe('permisos cambiados (las salas se reevalúan sin cortar la conexión)', () => {
    const conectado = (salas: string[]) => {
      const c = client();
      salas.forEach((x) => c.rooms.add(x));
      Object.assign(c.data, {
        identidad: {
          role: RoleType.ADMIN,
          distributorId: 'dist-1',
          userId: 'u-1',
        },
      });
      return c;
    };
    const conServidor = (conexiones: ReturnType<typeof client>[]) => {
      const fetchSockets = jest.fn().mockResolvedValue(conexiones);
      const enSala = jest.fn(() => ({ fetchSockets }));
      gateway.server = {
        ...server,
        in: enSala,
      } as unknown as import('socket.io').Namespace;
      return enSala;
    };

    it('quien perdió soporte.ver sale del soporte de la empresa y de sus conversaciones', async () => {
      const c = conectado([
        'distribuidora:dist-1',
        'chat:soporte:dist-1',
        'conv:c-1:company',
        'usuario:u-1',
      ]);
      const enSala = conServidor([c]);
      permisos.deUsuario.mockResolvedValueOnce({ permisos: ['pedidos.ver'] });
      await gateway.reevaluarSalas({ userIds: ['u-1'] });
      expect(enSala).toHaveBeenCalledWith('usuario:u-1');
      expect([...c.rooms].sort()).toEqual([
        'distribuidora:dist-1',
        'usuario:u-1',
      ]);
      expect(c.disconnect).not.toHaveBeenCalled();
    });

    it('quien ganó soporte.ver entra a la sala de soporte de su empresa', async () => {
      const c = conectado(['usuario:u-1']);
      conServidor([c]);
      await gateway.reevaluarSalas({ userIds: ['u-1'] });
      expect(c.rooms.has('chat:soporte:dist-1')).toBe(true);
    });

    it('si no se pueden leer los permisos, falla cerrado y lo saca', async () => {
      const c = conectado(['chat:soporte:dist-1', 'conv:c-1:company']);
      conServidor([c]);
      permisos.deUsuario.mockRejectedValueOnce(new Error('caído'));
      await gateway.reevaluarSalas({ userIds: ['u-1'] });
      expect([...c.rooms]).toEqual([]);
    });
  });

  describe('presencia del equipo de soporte (D-C26)', () => {
    const superAdmin = {
      userId: 's1',
      email: 'super@splg.com',
      role: RoleType.SUPER_ADMIN,
      distributorId: null,
    };

    it('al conectarse alguien con `plataforma.tickets.ver` avisa su conexión; sin el permiso, no', async () => {
      identidades.identificar.mockResolvedValue(superAdmin);
      await gateway.handleConnection(client() as unknown as SocketDeSplg);
      permisosDePlataforma.deUsuario.mockResolvedValue([]);
      await gateway.handleConnection(client() as unknown as SocketDeSplg);
      const avisos = events.emit.mock.calls.filter(
        ([e]) => e === EVENTO_SOPORTE_CONECTADO,
      );
      expect(avisos).toEqual([
        [EVENTO_SOPORTE_CONECTADO, { userId: 's1', socketId: 'sock-1' }],
      ]);
    });

    it('un admin de empresa no entra a la presencia', async () => {
      identidades.identificar.mockResolvedValue({
        userId: 'u1',
        email: 'admin@splg.com',
        role: RoleType.ADMIN,
        distributorId: 'dist-1',
      });
      await gateway.handleConnection(client() as unknown as SocketDeSplg);
      const c = client();
      Object.assign(c.data, {
        identidad: { ...superAdmin, role: RoleType.ADMIN },
      });
      gateway.handleDisconnect(c as unknown as SocketDeSplg);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('al desconectarse alguien de la plataforma avisa; sin identidad, nada', () => {
      const c = client();
      Object.assign(c.data, { identidad: superAdmin });
      gateway.handleDisconnect(c as unknown as SocketDeSplg);
      gateway.handleDisconnect(client() as unknown as SocketDeSplg);
      expect(events.emit.mock.calls).toEqual([
        [EVENTO_SOPORTE_DESCONECTADO, { userId: 's1', socketId: 'sock-1' }],
      ]);
    });

    it('las conexiones locales del soporte salen de la sala `chat:plataforma` de esta instancia', () => {
      const sockets = new Map([
        ['a', { data: { identidad: superAdmin } }],
        ['b', { data: {} }],
      ]);
      gateway.server = {
        adapter: {
          rooms: new Map([['chat:plataforma', new Set(['a', 'b', 'c'])]]),
        },
        sockets,
      } as unknown as import('socket.io').Namespace;
      expect(gateway.conexionesLocalesDelSoporte()).toEqual([
        { userId: 's1', socketId: 'a' },
      ]);
      gateway.server = {
        adapter: { rooms: new Map() },
        sockets,
      } as unknown as import('socket.io').Namespace;
      expect(gateway.conexionesLocalesDelSoporte()).toEqual([]);
    });

    it('un mismo evento a las salas de soporte de varias empresas en una sola emisión; sin empresas, nada', () => {
      gateway.emitirAlSoporteDeEmpresas(['d1', 'd2'], 'support:status', {
        teamOnline: true,
      });
      gateway.emitirAlSoporteDeEmpresas([], 'support:status', {});
      expect(server.to.mock.calls).toEqual([
        [['chat:soporte:d1', 'chat:soporte:d2']],
      ]);
      expect(emit).toHaveBeenCalledWith('support:status', { teamOnline: true });
    });
  });
});
