import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Namespace } from 'socket.io';
import type { StaffPermissionsService } from '../admin/staff-permissions.service';
import { RoleType } from '../common/constants/role-type.enum';
import type { PermisosDePlataformaService } from '../common/permisos/catalogo-de-plataforma';
import {
  AdminGateway,
  EVENTO_BANDEJA_CONECTADO,
  EVENTO_BANDEJA_DESCONECTADO,
} from './admin.gateway';
import type { ParticipacionEnConversaciones } from './participacion-en-conversaciones.service';
import type { SocketDeSplg } from './socket-data';
import type { SocketIdentityService } from './socket-identity.service';

/**
 * La presencia del equipo de la bandeja (8b): el gateway avisa al chat
 * quién del personal de una empresa con algún canal se conecta y se
 * desconecta, sabe cuáles de esas conexiones atiende esta instancia, y emite
 * al equipo (`chat:team`) y al resto del equipo de una conversación (sin
 * quien escribe).
 */
const admin = {
  userId: 'u1',
  email: 'ana@splg.com',
  role: RoleType.ADMIN,
  distributorId: 'dist-1',
};

const socket = (id: string) => {
  const rooms = new Set<string>();
  return {
    id,
    rooms,
    data: {} as Record<string, unknown>,
    join: jest.fn((sala: string) => {
      rooms.add(sala);
      return Promise.resolve();
    }),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
};

function armar(permisosDelRol: string[], identidad: unknown = admin) {
  const events = { emit: jest.fn() };
  const gateway = new AdminGateway(
    {
      identificar: jest.fn().mockResolvedValue(identidad),
      obtener: jest.fn().mockResolvedValue(identidad),
    } as unknown as SocketIdentityService,
    {
      deUsuario: jest.fn().mockResolvedValue({ permisos: permisosDelRol }),
    } as unknown as StaffPermissionsService,
    {
      deUsuario: jest.fn().mockResolvedValue([]),
    } as unknown as PermisosDePlataformaService,
    events as unknown as EventEmitter2,
    {} as unknown as ParticipacionEnConversaciones,
  );
  return { gateway, events };
}

describe('AdminGateway: presencia del equipo de la bandeja (8b)', () => {
  it('al conectarse alguien con un canal de la bandeja, avisa empresa, persona y conexión', async () => {
    for (const p of [['mensajes.clientes'], ['mensajes.choferes']]) {
      const { gateway, events } = armar(p);
      const s = socket('s1');
      await gateway.handleConnection(s as unknown as SocketDeSplg);
      expect(events.emit).toHaveBeenCalledWith(EVENTO_BANDEJA_CONECTADO, {
        distributorId: 'dist-1',
        userId: 'u1',
        socketId: 's1',
      });
    }
  });

  it('sin canal de la bandeja, no cuenta', async () => {
    const { gateway, events } = armar(['pedidos.ver', 'mensajes.supervisar']);
    await gateway.handleConnection(socket('s1') as unknown as SocketDeSplg);
    expect(events.emit).not.toHaveBeenCalledWith(
      EVENTO_BANDEJA_CONECTADO,
      expect.anything(),
    );
  });

  it('al desconectarse alguien del personal, avisa (sacar una que no estaba no hace nada)', () => {
    const { gateway, events } = armar(['mensajes.clientes']);
    const s = socket('s1');
    s.data.identidad = admin;
    gateway.handleDisconnect(s as unknown as SocketDeSplg);
    expect(events.emit).toHaveBeenCalledWith(EVENTO_BANDEJA_DESCONECTADO, {
      distributorId: 'dist-1',
      userId: 'u1',
      socketId: 's1',
    });
  });

  it('las conexiones locales de la bandeja: personal de empresa en alguna lista de la bandeja', () => {
    const { gateway } = armar([]);
    const enClientes = socket('a');
    enClientes.data.identidad = admin;
    enClientes.rooms.add('chat:clientes:dist-1');
    const enChoferes = socket('b');
    enChoferes.data.identidad = { ...admin, userId: 'u2' };
    enChoferes.rooms.add('chat:choferes:dist-1');
    const sinBandeja = socket('c');
    sinBandeja.data.identidad = { ...admin, userId: 'u3' };
    sinBandeja.rooms.add('admins:dist-1');
    const plataforma = socket('d');
    plataforma.data.identidad = {
      ...admin,
      role: RoleType.SUPER_ADMIN,
      distributorId: null,
    };
    gateway.server = {
      sockets: new Map([
        ['a', enClientes],
        ['b', enChoferes],
        ['c', sinBandeja],
        ['d', plataforma],
      ]),
    } as unknown as Namespace;
    expect(gateway.conexionesLocalesDeLaBandeja()).toEqual([
      { distributorId: 'dist-1', userId: 'u1', socketId: 'a' },
      { distributorId: 'dist-1', userId: 'u2', socketId: 'b' },
    ]);
  });

  it('chat:team va a las dos listas de la empresa en una sola emisión; chat:staff-typing, sin las conexiones de quien escribe', () => {
    const { gateway } = armar([]);
    const emit = jest.fn();
    const except = jest.fn(() => ({ emit }));
    const to = jest.fn(() => ({ emit, except }));
    gateway.server = { to } as unknown as Namespace;
    gateway.emitirAlEquipoDeLaBandeja('dist-1', 'chat:team', { x: 1 });
    expect(to).toHaveBeenCalledWith([
      'chat:clientes:dist-1',
      'chat:choferes:dist-1',
    ]);
    expect(emit).toHaveBeenCalledWith('chat:team', { x: 1 });
    gateway.emitirAConversacionMenosA(
      'conv-1',
      'company',
      'u1',
      'chat:staff-typing',
      { y: 2 },
    );
    expect(to).toHaveBeenLastCalledWith('conv:conv-1:company');
    expect(except).toHaveBeenCalledWith('usuario:u1');
    expect(emit).toHaveBeenLastCalledWith('chat:staff-typing', { y: 2 });
  });

  it('sin servidor todavía, ninguna conexión local', () => {
    const { gateway } = armar([]);
    expect(gateway.conexionesLocalesDeLaBandeja()).toEqual([]);
  });
});
