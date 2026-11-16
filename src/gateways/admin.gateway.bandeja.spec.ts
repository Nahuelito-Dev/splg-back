import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { StaffPermissionsService } from '../admin/staff-permissions.service';
import { RoleType } from '../common/constants/role-type.enum';
import type { PermisosDePlataformaService } from '../common/permisos/catalogo-de-plataforma';
import { AdminGateway } from './admin.gateway';
import { CustomersGateway } from './customers.gateway';
import { DriversGateway } from './drivers.gateway';
import type { ParticipacionEnConversaciones } from './participacion-en-conversaciones.service';
import type { RedisService } from '../redis/redis.service';
import type { SocketDeSplg } from './socket-data';
import type { SocketIdentityService } from './socket-identity.service';

/**
 * Salas de la bandeja de la empresa (CH3, D-C28): las listas por canal según
 * el permiso del rol, la sala de cada conversación C3/C2 sólo con el permiso
 * del canal (el admin sólo de choferes no entra a una C3), la plataforma nunca,
 * y en las apps sólo la persona de la conversación.
 */
const conv = '7a4c6c4e-1d7a-4b77-9d55-2a6f9e1c0b11';

const cliente = () => {
  const rooms = new Set<string>();
  return {
    id: 'sock-1',
    rooms,
    data: {} as Record<string, unknown>,
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

describe('AdminGateway: salas de la bandeja (CH3)', () => {
  const admin = {
    userId: 'u1',
    email: 'admin@splg.com',
    role: RoleType.ADMIN,
    distributorId: 'dist-1',
  };
  let identidades: { identificar: jest.Mock; obtener: jest.Mock };
  let permisos: { deUsuario: jest.Mock };
  let participacion: { deConversacion: jest.Mock; chatHabilitado: jest.Mock };
  let events: { emit: jest.Mock };
  let gateway: AdminGateway;

  beforeEach(() => {
    identidades = {
      identificar: jest.fn().mockResolvedValue(admin),
      obtener: jest.fn().mockResolvedValue(admin),
    };
    permisos = {
      deUsuario: jest
        .fn()
        .mockResolvedValue({ permisos: ['mensajes.choferes'] }),
    };
    participacion = {
      chatHabilitado: jest.fn().mockResolvedValue(true),
      deConversacion: jest.fn().mockResolvedValue({
        distributorId: 'dist-1',
        channel: 'staff_customer',
        customerUserId: 'cli-1',
        driverUserId: null,
      }),
    };
    events = { emit: jest.fn() };
    gateway = new AdminGateway(
      identidades as unknown as SocketIdentityService,
      permisos as unknown as StaffPermissionsService,
      {
        deUsuario: jest.fn().mockResolvedValue(['plataforma.tickets.ver']),
      } as unknown as PermisosDePlataformaService,
      events as unknown as EventEmitter2,
      participacion as unknown as ParticipacionEnConversaciones,
    );
  });

  it('al conectar entra a la lista de cada canal que atiende, y sólo a ésas', async () => {
    const soloChoferes = cliente();
    await gateway.handleConnection(soloChoferes as unknown as SocketDeSplg);
    permisos.deUsuario.mockResolvedValue({
      permisos: ['mensajes.clientes', 'mensajes.choferes', 'soporte.ver'],
    });
    const todo = cliente();
    await gateway.handleConnection(todo as unknown as SocketDeSplg);
    expect([...soloChoferes.rooms].sort()).toEqual([
      'admins:dist-1',
      'chat:choferes:dist-1',
      'usuario:u1',
    ]);
    expect([...todo.rooms].sort()).toEqual([
      'admins:dist-1',
      'chat:choferes:dist-1',
      'chat:clientes:dist-1',
      'chat:soporte:dist-1',
      'usuario:u1',
    ]);
  });

  it('el admin sólo de choferes no entra a la sala de una C3; con `mensajes.clientes`, sí', async () => {
    const c = cliente();
    const sin = await gateway.handleJoin(
      { conversationId: conv },
      c as unknown as SocketDeSplg,
    );
    permisos.deUsuario.mockResolvedValue({ permisos: ['mensajes.clientes'] });
    const con = await gateway.handleJoin(
      { conversationId: conv },
      c as unknown as SocketDeSplg,
    );
    expect([sin.ok, con.ok]).toEqual([false, true]);
    expect([...c.rooms]).toEqual([`conv:${conv}:company`]);
  });

  it('con el módulo `chat` apagado, nadie del personal entra a una sala de la bandeja', async () => {
    permisos.deUsuario.mockResolvedValue({ permisos: ['mensajes.clientes'] });
    participacion.chatHabilitado.mockResolvedValue(false);
    const r = await gateway.handleJoin(
      { conversationId: conv },
      cliente() as unknown as SocketDeSplg,
    );
    expect(r.ok).toBe(false);
  });

  it('la plataforma nunca entra a la sala de una conversación de la bandeja', async () => {
    identidades.obtener.mockResolvedValue({
      userId: 's1',
      email: 'superadmin@splg.com',
      role: RoleType.SUPER_ADMIN,
      distributorId: null,
    });
    const c = cliente();
    const r = await gateway.handleJoin(
      { conversationId: conv },
      c as unknown as SocketDeSplg,
    );
    expect(r.ok).toBe(false);
    expect(c.rooms.size).toBe(0);
  });

  it('«escribiendo…» en la bandeja pide el permiso del canal, además de la sala', async () => {
    permisos.deUsuario.mockResolvedValue({ permisos: ['mensajes.clientes'] });
    const c = cliente();
    await gateway.handleJoin(
      { conversationId: conv },
      c as unknown as SocketDeSplg,
    );
    await gateway.handleTyping(
      { conversationId: conv },
      c as unknown as SocketDeSplg,
    );
    expect(events.emit).toHaveBeenCalledWith(
      'panel.escribiendo',
      expect.objectContaining({ conversationId: conv, esPlataforma: false }),
    );
    events.emit.mockClear();
    c.data.ultimoEscribiendo = 0;
    permisos.deUsuario.mockResolvedValue({ permisos: ['mensajes.choferes'] });
    await gateway.handleTyping(
      { conversationId: conv },
      c as unknown as SocketDeSplg,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('«escribiendo…» de una nota interna (4a): sale marcado `internal`; sin marca o con otra cosa, no', async () => {
    permisos.deUsuario.mockResolvedValue({ permisos: ['mensajes.clientes'] });
    const c = cliente();
    await gateway.handleJoin(
      { conversationId: conv },
      c as unknown as SocketDeSplg,
    );
    for (const [cuerpo, internal] of [
      [{ conversationId: conv, internal: true }, true],
      [{ conversationId: conv }, false],
      [{ conversationId: conv, internal: 'true' }, false],
    ] as const) {
      events.emit.mockClear();
      c.data.ultimoEscribiendo = 0;
      await gateway.handleTyping(cuerpo, c as unknown as SocketDeSplg);
      expect(events.emit).toHaveBeenCalledWith(
        'panel.escribiendo',
        expect.objectContaining({ conversationId: conv, internal }),
      );
    }
  });

  it('si pierde `mensajes.clientes` con la conexión abierta, sale de la lista y de las salas C3', async () => {
    permisos.deUsuario.mockResolvedValue({
      permisos: ['mensajes.clientes', 'mensajes.choferes'],
    });
    const c = cliente();
    await gateway.handleConnection(c as unknown as SocketDeSplg);
    await gateway.handleJoin(
      { conversationId: conv },
      c as unknown as SocketDeSplg,
    );
    const conexion = {
      data: { identidad: admin },
      rooms: c.rooms,
      join: (s: string) => c.rooms.add(s),
      leave: (s: string) => c.rooms.delete(s),
    };
    gateway.server = {
      in: () => ({ fetchSockets: () => Promise.resolve([conexion]) }),
    } as unknown as import('socket.io').Namespace;
    permisos.deUsuario.mockResolvedValue({ permisos: ['mensajes.choferes'] });
    await gateway.reevaluarSalas({ userIds: ['u1'] });
    expect([...c.rooms].sort()).toEqual([
      'admins:dist-1',
      'chat:choferes:dist-1',
      'usuario:u1',
    ]);
  });
});

describe('Apps: salas de sus conversaciones con la empresa (CH3)', () => {
  /** Lo que diría la base: la persona de la conversación, vigente y de la empresa. */
  let vigente = true;
  let chat = true;
  const participacion = {
    deConversacion: jest.fn(),
    chatHabilitado: jest.fn(() => Promise.resolve(chat)),
    personaVigente: jest.fn(
      async (_id: string, userId: string, punta: 'customer' | 'driver') => {
        const c = (await participacion.deConversacion()) as {
          channel: string;
          customerUserId: string | null;
          driverUserId: string | null;
        };
        const suya =
          punta === 'customer'
            ? c.channel === 'staff_customer' && c.customerUserId === userId
            : c.channel === 'staff_driver' && c.driverUserId === userId;
        return suya && vigente;
      },
    ),
  };
  beforeEach(() => {
    vigente = true;
    chat = true;
  });
  const deCliente = {
    distributorId: 'dist-1',
    channel: 'staff_customer',
    customerUserId: 'cli-1',
    driverUserId: null,
  };
  const deChofer = {
    distributorId: 'dist-1',
    channel: 'staff_driver',
    customerUserId: null,
    driverUserId: 'cho-1',
  };
  const identidad = (userId: string, role: RoleType) => ({
    obtener: jest.fn().mockResolvedValue({
      userId,
      email: `${userId}@x.com`,
      role,
      distributorId: null,
    }),
    identificar: jest.fn(),
  });

  it('el cliente entra sólo a la suya, de C3', async () => {
    participacion.deConversacion.mockResolvedValue(deCliente);
    const events = { emit: jest.fn() };
    const g = new CustomersGateway(
      identidad('cli-1', RoleType.CUSTOMER) as unknown as SocketIdentityService,
      participacion as unknown as ParticipacionEnConversaciones,
      events as unknown as EventEmitter2,
    );
    const c = cliente();
    expect(
      await g.handleChatJoin(
        { conversationId: conv },
        c as unknown as SocketDeSplg,
      ),
    ).toEqual({ ok: true });
    expect([...c.rooms]).toEqual([`conv:${conv}:customer`]);
    await g.handleChatTyping(
      { conversationId: conv },
      c as unknown as SocketDeSplg,
    );
    expect(events.emit).toHaveBeenCalledWith('app.escribiendo', {
      conversationId: conv,
      userId: 'cli-1',
      punta: 'customer',
    });
    const otro = new CustomersGateway(
      identidad('cli-2', RoleType.CUSTOMER) as unknown as SocketIdentityService,
      participacion as unknown as ParticipacionEnConversaciones,
    );
    const c2 = cliente();
    expect(
      (
        await otro.handleChatJoin(
          { conversationId: conv },
          c2 as unknown as SocketDeSplg,
        )
      ).ok,
    ).toBe(false);
    participacion.deConversacion.mockResolvedValue(deChofer);
    expect(
      (
        await g.handleChatJoin(
          { conversationId: conv },
          cliente() as unknown as SocketDeSplg,
        )
      ).ok,
    ).toBe(false);
    expect(
      await g.handleChatJoin(
        { conversationId: 'x' },
        cliente() as unknown as SocketDeSplg,
      ),
    ).toMatchObject({ ok: false, code: 'INVALID_ID' });
  });

  it('el chofer entra sólo a la suya de C2; un admin por el namespace de choferes, no', async () => {
    participacion.deConversacion.mockResolvedValue(deChofer);
    const g = (userId: string, role: RoleType) =>
      new DriversGateway(
        {} as unknown as RedisService,
        identidad(userId, role) as unknown as SocketIdentityService,
        {} as unknown as CustomersGateway,
        {} as unknown as AdminGateway,
        undefined,
        participacion as unknown as ParticipacionEnConversaciones,
      );
    const c = cliente();
    expect(
      await g('cho-1', RoleType.DELIVERY).handleChatJoin(
        { conversationId: conv },
        c as unknown as SocketDeSplg,
      ),
    ).toEqual({ ok: true });
    expect([...c.rooms]).toEqual([`conv:${conv}:driver`]);
    expect(
      (
        await g('cho-1', RoleType.ADMIN).handleChatJoin(
          { conversationId: conv },
          cliente() as unknown as SocketDeSplg,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await g('cho-2', RoleType.DELIVERY).handleChatJoin(
          { conversationId: conv },
          cliente() as unknown as SocketDeSplg,
        )
      ).ok,
    ).toBe(false);
  });

  it('el «escribiendo…» de la app sale sólo desde una sala en la que entró', async () => {
    const events = { emit: jest.fn() };
    const g = new CustomersGateway(
      identidad('cli-1', RoleType.CUSTOMER) as unknown as SocketIdentityService,
      participacion as unknown as ParticipacionEnConversaciones,
      events as unknown as EventEmitter2,
    );
    await g.handleChatTyping(
      { conversationId: conv },
      cliente() as unknown as SocketDeSplg,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('si la persona ya no es de la empresa o el módulo `chat` está apagado, no entra', async () => {
    participacion.deConversacion.mockResolvedValue(deCliente);
    const g = new CustomersGateway(
      identidad('cli-1', RoleType.CUSTOMER) as unknown as SocketIdentityService,
      participacion as unknown as ParticipacionEnConversaciones,
    );
    vigente = false;
    expect(
      (
        await g.handleChatJoin(
          { conversationId: conv },
          cliente() as unknown as SocketDeSplg,
        )
      ).ok,
    ).toBe(false);
    vigente = true;
    chat = false;
    expect(
      (
        await g.handleChatJoin(
          { conversationId: conv },
          cliente() as unknown as SocketDeSplg,
        )
      ).ok,
    ).toBe(false);
  });
});
