import type { DataSource } from 'typeorm';
import type { AdminGateway } from '../../gateways/admin.gateway';
import type {
  ChatViewsService,
  ContextoDeVista,
} from '../application/chat-views.service';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
  SubjectType,
  TicketPriority,
  TicketStatus,
} from '../domain/chat.enums';
import type { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';
import type { SupportTicket } from '../entities/support-ticket.entity';
import type { Observador } from '../infrastructure/chat-read-model';
import {
  admiteEscribiendo,
  ChatRealtimeListener,
} from './chat-realtime.listener';
import { CompanyPlatformChatController } from './company-platform-chat.controller';
import { CompanyTicketsController } from './company-tickets.controller';
import { SIN_CONTROL_DE_ACCESO_KEY } from '../../common/decorators/sin-control-de-acceso.decorator';

const hilo = {
  conversationId: 'hilo-1',
  distributorId: 'dist-a',
  channel: Channel.PLATFORM_TICKET,
  subjectType: SubjectType.TICKET,
  status: ConversationStatus.OPEN,
  assignedToUserId: null,
  closedReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Conversation;

const chat = {
  ...hilo,
  conversationId: 'chat-1',
  channel: Channel.PLATFORM_CHAT,
  subjectType: SubjectType.GENERAL,
  assignedToUserId: 'super-1',
} as unknown as Conversation;

const mensaje = (visibility: MessageVisibility): Message =>
  ({
    messageId: 'm1',
    conversationId: 'hilo-1',
    distributorId: 'dist-a',
    seq: 4,
    clientMessageId: 'c1',
    senderParty: Party.PLATFORM,
    senderUserId: 'super-1',
    kind: MessageKind.TEXT,
    visibility,
    payload: null,
    body: 'Revisamos la factura',
    bodyFiltered: false,
    templateKey: null,
    systemCode: null,
    createdAt: new Date(),
    redactedAt: null,
  }) as unknown as Message;

function contexto(observador: Observador): ContextoDeVista {
  return {
    observador,
    plataforma: 'OrixTech',
    nombres: new Map([['super-1', 'Lucía Pérez']]),
    empresas: new Map([['dist-a', 'Gas Norte']]),
    noLeidos: new Map(),
    lecturaDeLaOtraParte: new Map(),
    lecturaPropia: new Map(),
    ultimos: new Map(),
    citados: new Map(),
    ticketsDesde: new Map(),
    ticketDelHilo: new Map(),
    sesiones: new Map(),
  };
}

describe('ChatRealtimeListener: cada punta recibe lo suyo (§7.3)', () => {
  let gateway: {
    emitirAlSoporteDeEmpresas: jest.Mock;
    emitirAlSoporteDeEmpresa: jest.Mock;
    emitirAlSoporteDePlataforma: jest.Mock;
    emitirAUsuario: jest.Mock;
    emitirAConversacion: jest.Mock;
  };
  let listener: ChatRealtimeListener;
  let conversaciones: Conversation[];

  beforeEach(() => {
    gateway = {
      emitirAlSoporteDeEmpresas: jest.fn(),
      emitirAlSoporteDeEmpresa: jest.fn(),
      emitirAlSoporteDePlataforma: jest.fn(),
      emitirAUsuario: jest.fn(),
      emitirAConversacion: jest.fn(),
    };
    conversaciones = [chat, hilo];
    listener = new ChatRealtimeListener(
      gateway as unknown as AdminGateway,
      {
        contexto: (o: Observador) => Promise.resolve(contexto(o)),
      } as unknown as ChatViewsService,
      {
        query: () =>
          Promise.resolve([
            { distributor_id: 'dist-a' },
            { distributor_id: 'dist-b' },
          ]),
        getRepository: () => ({
          findOne: ({ where }: { where: { conversationId: string } }) =>
            Promise.resolve(
              conversaciones.find(
                (c) => c.conversationId === where.conversationId,
              ) ?? null,
            ),
        }),
      } as unknown as DataSource,
    );
  });

  /** [conversación, punta, evento] de cada emisión a una sala de conversación. */
  const llamadas = () =>
    gateway.emitirAConversacion.mock.calls as Array<
      [string, string, string, unknown]
    >;
  const aConversacion = () => llamadas().map(([c, p, e]) => [c, p, e]);

  it('D-C28: una nota interna va sólo a la mitad de la plataforma de su sala; la empresa no recibe nada', async () => {
    await listener.mensaje({
      conversation: hilo,
      message: mensaje(MessageVisibility.INTERNAL),
    });
    expect(aConversacion()).toEqual([['hilo-1', 'platform', 'chat:message']]);
    expect(gateway.emitirAlSoporteDeEmpresa).not.toHaveBeenCalled();
  });

  it('D-C28: el cuerpo viaja sólo a la sala de la conversación, cada punta con su versión', async () => {
    await listener.mensaje({
      conversation: hilo,
      message: mensaje(MessageVisibility.ALL),
    });
    expect(aConversacion()).toEqual([
      ['hilo-1', 'platform', 'chat:message'],
      ['hilo-1', 'company', 'chat:message'],
    ]);
    const carga = (punta: string) =>
      (
        llamadas().find((c) => c[1] === punta) as [
          string,
          string,
          string,
          { message: { sender: unknown; isMine: boolean } },
        ]
      )[3].message;
    // La empresa ve el nombre de pila de quien la atiende (D-C19), no el completo.
    expect(carga('company')).toMatchObject({
      sender: { displayName: 'Lucía' },
      isMine: false,
    });
    expect(carga('platform')).toMatchObject({
      sender: { displayName: 'Lucía Pérez' },
      isMine: true,
    });
  });

  it('D-C28: a las salas de lista sólo va el aviso liviano, sin el cuerpo', async () => {
    await listener.mensaje({
      conversation: hilo,
      message: mensaje(MessageVisibility.ALL),
    });
    const [evento, aviso] = (
      gateway.emitirAlSoporteDeEmpresa.mock.calls[0] as unknown[]
    ).slice(1) as [string, Record<string, unknown>];
    expect(evento).toBe('chat:inbox');
    expect(aviso).not.toHaveProperty('message');
    expect(aviso).toMatchObject({
      conversationId: 'hilo-1',
      lastMessage: {
        seq: 4,
        party: Party.PLATFORM,
        preview: 'Revisamos la factura',
      },
    });
    expect(gateway.emitirAlSoporteDePlataforma).toHaveBeenCalledWith(
      'chat:inbox',
      expect.not.objectContaining({ message: expect.anything() as unknown }),
    );
  });

  it('el cambio de un chat no le dice a la empresa quién la atiende más que el nombre de pila', async () => {
    await listener.conversacion({ conversation: chat, change: 'assigned' });
    const [, , , carga] = llamadas().find((c) => c[1] === 'company') as [
      string,
      string,
      string,
      { conversation: Record<string, unknown> },
    ];
    expect(carga.conversation).not.toHaveProperty('assignedTo');
    expect(carga.conversation.attendedBy).toEqual({ displayName: 'Lucía' });
  });

  it('el «leído» de la empresa va a la mitad de la plataforma de la sala y no vuelve a la empresa', async () => {
    await listener.lectura({
      conversationId: 'chat-1',
      distributorId: 'dist-a',
      channel: Channel.PLATFORM_CHAT,
      party: Party.COMPANY,
      lastReadSeq: 7,
      userId: 'admin-a',
      personal: true,
      deLaParte: true,
    });
    expect(gateway.emitirAConversacion).toHaveBeenCalledWith(
      'chat-1',
      'platform',
      'chat:read',
      { conversationId: 'chat-1', party: Party.COMPANY, lastReadSeq: 7 },
    );
    expect(aConversacion()).toEqual([['chat-1', 'platform', 'chat:read']]);
  });

  it('B4: el «leído» llega a las otras pestañas de quien leyó, aunque la punta no suba', async () => {
    await listener.lectura({
      conversationId: 'chat-1',
      distributorId: 'dist-a',
      channel: Channel.PLATFORM_CHAT,
      party: Party.COMPANY,
      lastReadSeq: 7,
      userId: 'admin-a',
      personal: true,
      deLaParte: false,
    });
    expect(gateway.emitirAUsuario).toHaveBeenCalledWith(
      'admin-a',
      'chat:read',
      {
        conversationId: 'chat-1',
        party: Party.COMPANY,
        lastReadSeq: 7,
      },
    );
    expect(gateway.emitirAlSoporteDePlataforma).not.toHaveBeenCalled();
    expect(gateway.emitirAlSoporteDeEmpresa).not.toHaveBeenCalled();
  });

  it('ticket:updated a la empresa sin el asignado; a la plataforma, con', async () => {
    await listener.ticket({
      change: 'updated',
      ticket: {
        ticketId: 't1',
        number: 12,
        distributorId: 'dist-a',
        conversationId: 'hilo-1',
        originConversationId: 'chat-1',
        status: TicketStatus.RESOLVED,
        priority: TicketPriority.HIGH,
        subject: 'Factura duplicada',
        assignedMemberUserId: 'super-1',
      } as unknown as SupportTicket,
    });
    const [, , empresa] = gateway.emitirAlSoporteDeEmpresa.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(empresa).not.toHaveProperty('assignedTo');
    expect(empresa).toMatchObject({ number: 'T-000012', status: 'resolved' });
    expect(gateway.emitirAlSoporteDePlataforma).toHaveBeenCalledWith(
      'ticket:updated',
      expect.objectContaining({ assignedTo: 'super-1' }),
    );
  });

  it('«escribiendo…» de un admin sobre una conversación de otra empresa no se reenvía a nadie', async () => {
    await listener.escribiendo({
      conversationId: 'chat-1',
      userId: 'admin-b',
      distributorId: 'dist-b',
      esPlataforma: false,
    });
    await listener.escribiendo({
      conversationId: 'chat-1',
      userId: 'admin-a',
      distributorId: 'dist-a',
      esPlataforma: false,
    });
    // Sólo el de A, sólo a la mitad de la plataforma de esa conversación.
    expect(aConversacion()).toEqual([['chat-1', 'platform', 'chat:typing']]);
    expect(gateway.emitirAlSoporteDePlataforma).not.toHaveBeenCalled();
  });

  it('D-C26: `support:status` va a la sala de soporte de cada empresa dada de alta, sin datos del equipo', async () => {
    const estado = {
      openNow: false,
      nextOpenAt: '2026-11-16T12:00:00.000Z',
      teamOnline: true,
    };
    await listener.estadoDelSoporte(estado);
    expect(gateway.emitirAlSoporteDeEmpresas).toHaveBeenCalledWith(
      ['dist-a', 'dist-b'],
      'support:status',
      estado,
    );
    expect(gateway.emitirAlSoporteDePlataforma).not.toHaveBeenCalled();
  });
});

describe('B1: «escribiendo…» sólo en conversaciones abiertas de C1', () => {
  const base = {
    conversationId: 'c-x',
    distributorId: 'dist-a',
    status: ConversationStatus.OPEN,
  };
  it.each([
    [Channel.PLATFORM_CHAT, ConversationStatus.OPEN, true],
    [Channel.PLATFORM_TICKET, ConversationStatus.OPEN, true],
    [Channel.PLATFORM_CHAT, ConversationStatus.CLOSED, false],
    ['staff_customer', ConversationStatus.OPEN, false],
    ['driver_customer', ConversationStatus.OPEN, false],
  ])('canal %s %s → %s', (channel, status, esperado) => {
    expect(
      admiteEscribiendo({
        ...base,
        channel,
        status,
      } as unknown as Conversation),
    ).toBe(esperado);
  });

  it('el «escribiendo» de la empresa en un chat privado (C3) no llega a la plataforma', async () => {
    const gateway = {
      emitirAlSoporteDeEmpresa: jest.fn(),
      emitirAlSoporteDePlataforma: jest.fn(),
      emitirAConversacion: jest.fn(),
    };
    const privado = {
      ...base,
      conversationId: 'c3',
      channel: 'staff_customer',
    } as unknown as Conversation;
    const listener = new ChatRealtimeListener(
      gateway as unknown as AdminGateway,
      {} as ChatViewsService,
      {
        getRepository: () => ({ findOne: () => Promise.resolve(privado) }),
      } as unknown as DataSource,
    );
    await listener.escribiendo({
      conversationId: 'c3',
      userId: 'admin-a',
      distributorId: 'dist-a',
      esPlataforma: false,
    });
    expect(gateway.emitirAlSoporteDePlataforma).not.toHaveBeenCalled();
    expect(gateway.emitirAConversacion).not.toHaveBeenCalled();
  });
});

describe('C1 es núcleo: una empresa suspendida o restringida lo sigue usando', () => {
  it.each([CompanyPlatformChatController, CompanyTicketsController])(
    '%p lleva @SinControlDeAcceso()',
    (controller) => {
      expect(Reflect.getMetadata(SIN_CONTROL_DE_ACCESO_KEY, controller)).toBe(
        true,
      );
    },
  );
});
