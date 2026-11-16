import type { DataSource, EntityManager } from 'typeorm';
import type { StaffPermissionsService } from '../../admin/staff-permissions.service';
import { RoleType } from '../../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  Party,
  TicketStatus,
} from '../domain/chat.enums';
import {
  ConversacionNoEncontradaError,
  TicketCerradoError,
  TicketNoEncontradoError,
} from '../domain/chat.errors';
import type { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';
import type { SupportTicket } from '../entities/support-ticket.entity';
import type {
  AdjuntosDelChat,
  EscribirElMensaje,
  PedidoDeAdjunto,
} from './adjuntos-del-chat.service';
import { BandejaAcceso } from './bandeja-acceso';
import { BandejaAdjuntos } from './bandeja-adjuntos.service';
import { Efectos } from './chat.events';
import type { ChatNotices } from './chat-notices';
import type { ChatThreadsService } from './chat-threads.service';
import type { CompanyChatSettingsService } from './company-chat-settings.service';
import type { ConversacionVigente } from './conversacion-vigente';
import type { NuevoMensaje } from './mensajes.port';
import type { MessageWriter } from './message-writer';
import { SoporteAdjuntos } from './soporte-adjuntos.service';
import type { TicketActivityService } from './ticket-activity.service';

const CMID = '0d6f0c34-8b7e-4c1a-9f3b-5a2e7d9c1b20';
const nuevo = {
  conversationId: 'conv-1',
  kind: MessageKind.ATTACHMENT,
} as NuevoMensaje;

/** Lo que hace `AdjuntosDelChat.subir` con el callback del canal: lo corre en una transacción simulada. */
function adjuntosQueEscriben(manager: object) {
  const pedidos: PedidoDeAdjunto[] = [];
  const efectos = new Efectos();
  const adjuntos = {
    subir: jest.fn(async (p: PedidoDeAdjunto, escribir: EscribirElMensaje) => {
      pedidos.push(p);
      const r = await escribir(
        manager as unknown as EntityManager,
        nuevo,
        efectos,
      );
      return { ...r, attachment: null };
    }),
    enlace: jest.fn().mockResolvedValue({ url: 'u' }),
  };
  return { adjuntos, pedidos, efectos };
}

function conversacion(extra: Partial<Conversation> = {}): Conversation {
  return {
    conversationId: 'conv-1',
    distributorId: 'dist-a',
    channel: Channel.STAFF_CUSTOMER,
    status: ConversationStatus.OPEN,
    awaitingHumanSince: new Date(),
    ...extra,
  } as Conversation;
}

describe('BandejaAdjuntos: aislamiento y efectos de la bandeja', () => {
  /** El `BandejaAcceso` de verdad sobre una base simulada: se ve con qué filtra. */
  function armar(opciones: { encontrada?: boolean; clientes?: boolean } = {}) {
    const wheres: Array<Record<string, unknown>> = [];
    const dataSource = {
      manager: {
        getRepository: () => ({
          findOne: ({ where }: { where: Record<string, unknown> }) => {
            wheres.push(where);
            return Promise.resolve(
              opciones.encontrada === false ? null : conversacion(),
            );
          },
        }),
      },
    };
    const acceso = new BandejaAcceso(
      dataSource as unknown as DataSource,
      {
        deUsuario: () => Promise.resolve({ permisos: ['mensajes.clientes'] }),
      } as unknown as StaffPermissionsService,
    );
    const manager = { query: jest.fn().mockResolvedValue([]) };
    const { adjuntos, pedidos } = adjuntosQueEscriben(manager);
    const vigente = { assertSePuedeEscribir: jest.fn() };
    const ajustes = {
      leer: jest
        .fn()
        .mockResolvedValue({ customerChatEnabled: opciones.clientes ?? true }),
    };
    const writer = {
      escribir: jest.fn((_m: unknown, n: NuevoMensaje) =>
        Promise.resolve({
          message: { messageId: 'msg-1', ...n } as unknown as Message,
          created: true,
          conversation: conversacion(),
        }),
      ),
    };
    const servicio = new BandejaAdjuntos(
      acceso,
      vigente as unknown as ConversacionVigente,
      ajustes as unknown as CompanyChatSettingsService,
      writer as unknown as MessageWriter,
      adjuntos as unknown as AdjuntosDelChat,
    );
    return { servicio, acceso, wheres, manager, adjuntos, pedidos, vigente };
  }
  const usuario = (role: RoleType) =>
    ({ user_id: 'u1', role }) as AuthenticatedUser;
  const dto = { clientMessageId: CMID };

  it('un chofer sólo busca en C2 y en las suyas: no baja adjuntos de C3', async () => {
    const t = armar({ encontrada: false });
    const chofer = t.acceso.deLaPersona(usuario(RoleType.DELIVERY), 'dist-a');
    await expect(
      t.servicio.enlace(chofer, 'conv-de-un-cliente', 'msg-1'),
    ).rejects.toBeInstanceOf(ConversacionNoEncontradaError);
    expect(t.wheres[0]).toMatchObject({
      conversationId: 'conv-de-un-cliente',
      distributorId: 'dist-a',
      driverUserId: 'u1',
    });
    expect(JSON.stringify(t.wheres[0].channel)).toContain('staff_driver');
    expect(JSON.stringify(t.wheres[0].channel)).not.toContain('staff_customer');
    expect(t.adjuntos.enlace).not.toHaveBeenCalled();
  });

  it('la conversación de la empresa A pedida con el tenant B → 404 (filtra por la empresa de quien pide)', async () => {
    const t = armar({ encontrada: false });
    const deB = await t.acceso.delPersonal(usuario(RoleType.ADMIN), 'dist-b');
    await expect(
      t.servicio.enlace(deB, 'conv-1', 'msg-1'),
    ).rejects.toBeInstanceOf(ConversacionNoEncontradaError);
    expect(t.wheres[0]).toMatchObject({ distributorId: 'dist-b' });
    await expect(
      t.servicio.enviar(deB, 'conv-1', undefined, dto),
    ).rejects.toBeInstanceOf(ConversacionNoEncontradaError);
    expect(t.adjuntos.subir).not.toHaveBeenCalled();
  });

  it('el adjunto de la empresa es su respuesta: primera respuesta y deja de esperar persona; sin cupo por conversación', async () => {
    const t = armar();
    const personal = await t.acceso.delPersonal(
      usuario(RoleType.ADMIN),
      'dist-a',
    );
    await t.servicio.enviar(personal, 'conv-1', undefined, dto);
    expect(t.vigente.assertSePuedeEscribir).toHaveBeenCalled();
    const sqls = t.manager.query.mock.calls.map(([s]) => s as string);
    expect(sqls.some((s) => s.includes('"first_response_at"'))).toBe(true);
    expect(sqls.some((s) => s.includes('"awaiting_human_since" = NULL'))).toBe(
      true,
    );
    expect(t.pedidos[0]).toMatchObject({
      party: Party.COMPANY,
      cupo: { ambito: 'dist-a', conversacion: undefined },
    });
  });

  it('el del cliente no cuenta como respuesta y gasta el cupo de la conversación', async () => {
    const t = armar();
    const cliente = t.acceso.deLaPersona(usuario(RoleType.CUSTOMER), 'dist-a');
    await t.servicio.enviar(cliente, 'conv-1', undefined, dto);
    expect(t.manager.query).not.toHaveBeenCalled();
    expect(t.pedidos[0].cupo).toEqual({
      ambito: 'dist-a',
      conversacion: 'conv-1',
    });
  });

  it('con el chat de clientes apagado, el cliente no sube (403)', async () => {
    const t = armar({ clientes: false });
    const cliente = t.acceso.deLaPersona(usuario(RoleType.CUSTOMER), 'dist-a');
    await expect(
      t.servicio.enviar(cliente, 'conv-1', undefined, dto),
    ).rejects.toMatchObject({ status: 403 });
    expect(t.adjuntos.subir).not.toHaveBeenCalled();
  });

  it('la lectura va con la punta de quien pide', async () => {
    const t = armar();
    const cliente = t.acceso.deLaPersona(usuario(RoleType.CUSTOMER), 'dist-a');
    await t.servicio.enlace(cliente, 'conv-1', 'msg-1');
    expect(t.adjuntos.enlace).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
      'msg-1',
      { party: Party.CUSTOMER },
    );
  });
});

describe('SoporteAdjuntos: chat con la plataforma y tickets', () => {
  function armar(ticket: Partial<SupportTicket> | null = {}) {
    const buscados: unknown[] = [];
    const ticketsBuscados: unknown[] = [];
    const t = ticket
      ? ({
          ticketId: 't-1',
          distributorId: 'dist-a',
          conversationId: 'hilo-1',
          status: TicketStatus.OPEN,
          ...ticket,
        } as SupportTicket)
      : null;
    const manager = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: () => ({
        findOne: () => Promise.resolve(t),
      }),
    };
    const dataSource = {
      getRepository: () => ({
        findOne: (o: unknown) => {
          ticketsBuscados.push(o);
          return Promise.resolve(t);
        },
      }),
    };
    const hilos = {
      buscar: jest.fn((h: unknown) => {
        buscados.push(h);
        return Promise.resolve(
          conversacion({
            conversationId: 'hilo-1',
            channel: Channel.PLATFORM_TICKET,
          }),
        );
      }),
    };
    const writer = {
      escribir: jest.fn((_m: unknown, n: NuevoMensaje) =>
        Promise.resolve({
          message: { messageId: 'msg-1', ...n } as unknown as Message,
          created: true,
          conversation: conversacion(),
        }),
      ),
    };
    const actividad = {
      alResponder: jest.fn((_m: unknown, _a: unknown, tk: SupportTicket) =>
        Promise.resolve({ ...tk, status: TicketStatus.WAITING_COMPANY }),
      ),
    };
    const avisos = { respuestaDeLaPlataforma: jest.fn() };
    const { adjuntos, pedidos } = adjuntosQueEscriben(manager);
    const servicio = new SoporteAdjuntos(
      dataSource as unknown as DataSource,
      hilos as unknown as ChatThreadsService,
      writer as unknown as MessageWriter,
      actividad as unknown as TicketActivityService,
      avisos as unknown as ChatNotices,
      adjuntos as unknown as AdjuntosDelChat,
    );
    return {
      servicio,
      hilos,
      buscados,
      ticketsBuscados,
      actividad,
      avisos,
      adjuntos,
      pedidos,
      manager,
    };
  }
  const dto = { clientMessageId: CMID };
  const empresa = {
    party: Party.COMPANY as const,
    userId: 'adm-1',
    distributorId: 'dist-a',
  };
  const plataforma = {
    party: Party.PLATFORM as const,
    userId: 'pl-1',
    distributorId: null,
  };

  it('la empresa sube al chat suyo: busca el chat con su empresa', async () => {
    const t = armar();
    await t.servicio.alChatComoEmpresa(
      'dist-a',
      'adm-1',
      'chat-1',
      undefined,
      dto,
    );
    expect(t.buscados[0]).toEqual({
      conversationId: 'chat-1',
      channel: Channel.PLATFORM_CHAT,
      distributorId: 'dist-a',
    });
    expect(t.pedidos[0]).toMatchObject({
      party: Party.COMPANY,
      cupo: { ambito: 'dist-a' },
    });
  });

  it('la plataforma sube al chat de una empresa: cuenta como su primera respuesta', async () => {
    const t = armar();
    await t.servicio.alChatComoPlataforma('pl-1', 'chat-1', undefined, dto);
    expect(t.buscados[0]).toMatchObject({ distributorId: null });
    expect(t.pedidos[0].cupo).toEqual({ ambito: 'chat:chat-1' });
    expect(
      t.manager.query.mock.calls.some(([s]) =>
        (s as string).includes('"first_response_at"'),
      ),
    ).toBe(true);
  });

  it('un ticket de otra empresa es 404 y no sube nada', async () => {
    const t = armar(null);
    await expect(
      t.servicio.alTicket(empresa, 't-de-b', undefined, dto),
    ).rejects.toBeInstanceOf(TicketNoEncontradoError);
    expect(t.ticketsBuscados[0]).toEqual({
      where: { ticketId: 't-de-b', distributorId: 'dist-a' },
    });
    expect(t.adjuntos.subir).not.toHaveBeenCalled();
  });

  it('ticket cerrado: 409 `TICKET_CLOSED` antes de subir', async () => {
    const t = armar({ status: TicketStatus.CLOSED });
    await expect(
      t.servicio.alTicket(empresa, 't-1', undefined, dto),
    ).rejects.toBeInstanceOf(TicketCerradoError);
    expect(t.adjuntos.subir).not.toHaveBeenCalled();
  });

  it('la plataforma responde con un archivo: mueve el ticket y avisa a la empresa', async () => {
    const t = armar();
    const r = await t.servicio.alTicket(plataforma, 't-1', undefined, dto);
    expect(t.actividad.alResponder).toHaveBeenCalledTimes(1);
    expect(r.ticket.status).toBe(TicketStatus.WAITING_COMPANY);
    expect(t.avisos.respuestaDeLaPlataforma).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 't-1' }),
      'msg-1',
    );
    expect(t.pedidos[0].cupo).toEqual({ ambito: 'ticket:t-1' });
  });

  it('la empresa responde con un archivo: no se avisa a sí misma', async () => {
    const t = armar();
    await t.servicio.alTicket(empresa, 't-1', undefined, dto);
    expect(t.avisos.respuestaDeLaPlataforma).not.toHaveBeenCalled();
  });

  it('las lecturas del soporte van con la punta y la empresa de quien pide', async () => {
    const t = armar();
    await t.servicio.enlaceDelTicket(empresa, 't-1', 'msg-1');
    expect(t.adjuntos.enlace).toHaveBeenCalledWith(expect.anything(), 'msg-1', {
      party: Party.COMPANY,
    });
    await t.servicio.enlaceDelChat(Party.PLATFORM, null, 'chat-1', 'msg-2');
    expect(t.buscados.at(-1)).toMatchObject({
      channel: Channel.PLATFORM_CHAT,
      distributorId: null,
    });
  });
});
