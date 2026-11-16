import type { DataSource } from 'typeorm';
import {
  dentroDeCorrida,
  nuevaCorrida,
} from '../../process-run/process-run.context';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  Party,
} from '../domain/chat.enums';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import type { AsistenteDelChat } from './asistente-del-chat';
import type { ChatEvents } from './chat.events';
import type { ChatRateLimit } from './chat-rate-limit';
import type { ConversationFactory } from './conversation-factory';
import type { MessageWriter } from './message-writer';
import { PlatformChatService } from './platform-chat.service';
import type { RespuestasFijas } from './respuestas-fijas';

const DERIVADA = new Date('2026-11-15T12:00:00Z');
const UUID = '0d6f0c34-8b7e-4c1a-9f3b-5a2e7d9c1b20';

function armar(cambios: Partial<Conversation> = {}, iaSeEncarga = false) {
  const chat = Object.assign(new Conversation(), {
    conversationId: 'chat-1',
    distributorId: 'dist-a',
    channel: Channel.PLATFORM_CHAT,
    status: ConversationStatus.OPEN,
    assignedToUserId: null,
    awaitingHumanSince: DERIVADA,
    ...cambios,
  });
  const guardados: Conversation[] = [];
  const consultas: string[] = [];
  const qb: Record<string, jest.Mock> = {};
  for (const f of ['innerJoin', 'where', 'andWhere']) qb[f] = jest.fn(() => qb);
  qb.getOne = jest.fn(() => Promise.resolve(null));
  const repo = {
    findOne: jest.fn(() => Promise.resolve(chat)),
    findOneByOrFail: jest.fn(() => Promise.resolve(chat)),
    createQueryBuilder: jest.fn(() => qb),
    save: jest.fn((c: Conversation) => {
      guardados.push({ ...c } as Conversation);
      return Promise.resolve(c);
    }),
  };
  const manager = {
    getRepository: jest.fn(() => repo),
    query: jest.fn((sql: string) => {
      consultas.push(sql);
      return Promise.resolve([]);
    }),
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) =>
      cb(manager),
    ),
  };
  const escribir = jest.fn((_m: unknown, nuevo: Partial<Message>) =>
    Promise.resolve({
      message: Object.assign(new Message(), {
        ...nuevo,
        messageId: 'msg-7',
        seq: 7,
      }),
      created: true,
      conversation: chat,
    }),
  );
  const eventos = { publicar: jest.fn() };
  const fijas = { delSoporte: jest.fn(() => Promise.resolve(true)) };
  const asistente = {
    seEncarga: jest.fn(() => Promise.resolve(iaSeEncarga)),
  };
  const cupos = { mensaje: jest.fn() };
  const servicio = new PlatformChatService(
    dataSource as unknown as DataSource,
    { escribir } as unknown as MessageWriter,
    {} as ConversationFactory,
    cupos as unknown as ChatRateLimit,
    eventos as unknown as ChatEvents,
    fijas as unknown as RespuestasFijas,
    asistente as unknown as AsistenteDelChat,
  );
  return {
    servicio,
    cupos,
    guardados,
    eventos,
    consultas,
    fijas,
    asistente,
    escribir,
    chat,
  };
}

describe('PlatformChatService con el asistente con IA del soporte (B3)', () => {
  it('quien lo toma lo atiende y deja de esperar a una persona', async () => {
    const { servicio, guardados, eventos } = armar();
    await servicio.tomar('chat-1', 'plat-1');
    expect(guardados[0]).toMatchObject({
      assignedToUserId: 'plat-1',
      awaitingHumanSince: null,
    });
    expect(eventos.publicar).toHaveBeenCalledTimes(1);
  });

  it('soltarlo lo devuelve a la cola sin tocar la espera', async () => {
    const { servicio, guardados } = armar({ assignedToUserId: 'plat-1' });
    await servicio.soltar('chat-1', 'plat-1');
    expect(guardados[0]).toMatchObject({
      assignedToUserId: null,
      awaitingHumanSince: DERIVADA,
    });
  });

  it('la plataforma escribe: deja de esperar a una persona', async () => {
    const { servicio, consultas, chat } = armar();
    await servicio.responder('chat-1', 'plat-1', {
      clientMessageId: UUID,
      body: 'Hola, te atiendo yo',
    });
    expect(
      consultas.some((q) => q.includes('SET "awaiting_human_since" = NULL')),
    ).toBe(true);
    expect(chat.awaitingHumanSince).toBeNull();
  });

  it('cerrarlo deja de esperar a una persona', async () => {
    const { servicio, guardados } = armar();
    await servicio.cerrar('chat-1', 'plat-1');
    expect(guardados[0]).toMatchObject({
      status: ConversationStatus.CLOSED,
      awaitingHumanSince: null,
    });
  });

  it('la empresa escribe: si la IA se encarga no van las fijas (recibido, fuera de horario); si no, sí', async () => {
    const conIa = armar({ awaitingHumanSince: null }, true);
    await conIa.servicio.enviarComoEmpresa('dist-a', 'adm-1', {
      clientMessageId: UUID,
      body: '¿Cómo cargo un chofer?',
    });
    expect(conIa.asistente.seEncarga).toHaveBeenCalledWith(
      expect.anything(),
      conIa.chat,
      expect.objectContaining({ messageId: 'msg-7', seq: 7 }),
      expect.any(Date),
    );
    expect(conIa.fijas.delSoporte).not.toHaveBeenCalled();
    const sinIa = armar({ awaitingHumanSince: null }, false);
    await sinIa.servicio.enviarComoEmpresa('dist-a', 'adm-1', {
      clientMessageId: UUID,
      body: '¿Cómo cargo un chofer?',
    });
    expect(sinIa.fijas.delSoporte).toHaveBeenCalledTimes(1);
    expect(
      (
        sinIa.escribir.mock.calls[0][1] as {
          senderParty: Party;
          kind: MessageKind;
        }
      ).senderParty,
    ).toBe(Party.COMPANY);
  });
});

describe('PlatformChatService: la marca de reintento lleva la empresa', () => {
  it('la empresa y la plataforma escribiéndole a una empresa: la empresa; respondiendo un chat puntual: ese chat', async () => {
    const t = armar({ awaitingHumanSince: null });
    const dto = { clientMessageId: UUID, body: 'Hola' };
    await t.servicio.enviarComoEmpresa('dist-a', 'adm-1', dto);
    expect(t.cupos.mensaje).toHaveBeenLastCalledWith({
      ambito: 'dist-a',
      userId: 'adm-1',
      clientMessageId: UUID,
    });
    await t.servicio.responder('chat-1', 'plat-1', dto);
    expect(t.cupos.mensaje).toHaveBeenLastCalledWith({
      ambito: 'chat:chat-1',
      userId: 'plat-1',
      clientMessageId: UUID,
    });
  });
});

describe('PlatformChatService.cerrarInactivos: una empresa no frena a las demás', () => {
  const AHORA = new Date('2026-11-15T12:00:00Z');
  const VIEJO = new Date('2026-11-13T12:00:00Z');

  it('el chat de A que falla siempre no impide cerrar el de B; queda en el monitoreo y A se reintenta', async () => {
    const chats: Record<string, Conversation> = {
      'a-chat': Object.assign(new Conversation(), {
        conversationId: 'a-chat',
        distributorId: 'dist-a',
        channel: Channel.PLATFORM_CHAT,
        status: ConversationStatus.OPEN,
        lastMessageAt: VIEJO,
        createdAt: VIEJO,
      }),
      'b-chat': Object.assign(new Conversation(), {
        conversationId: 'b-chat',
        distributorId: 'dist-b',
        channel: Channel.PLATFORM_CHAT,
        status: ConversationStatus.OPEN,
        lastMessageAt: VIEJO,
        createdAt: VIEJO,
      }),
    };
    const cerrados: string[] = [];
    const repo = {
      findOne: jest.fn(({ where }: { where: { conversationId: string } }) =>
        where.conversationId === 'a-chat'
          ? Promise.reject(new Error('fila de A rota'))
          : Promise.resolve(chats[where.conversationId]),
      ),
      findOneByOrFail: jest.fn(
        ({ conversationId }: { conversationId: string }) =>
          Promise.resolve(chats[conversationId]),
      ),
      save: jest.fn((c: Conversation) => {
        cerrados.push(c.conversationId);
        return Promise.resolve(c);
      }),
    };
    const manager = { getRepository: () => repo };
    const dataSource = {
      query: jest.fn(() =>
        Promise.resolve([
          { id: 'a-chat', empresa: 'dist-a' },
          { id: 'b-chat', empresa: 'dist-b' },
        ]),
      ),
      transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) =>
        cb(manager),
      ),
    };
    const escribir = jest.fn((_m: unknown, nuevo: { conversationId: string }) =>
      Promise.resolve({
        message: Object.assign(new Message(), { messageId: 'sys-1' }),
        created: true,
        conversation: chats[nuevo.conversationId],
      }),
    );
    const eventos = { publicar: jest.fn() };
    const servicio = new PlatformChatService(
      dataSource as unknown as DataSource,
      { escribir } as unknown as MessageWriter,
      {} as ConversationFactory,
      { mensaje: jest.fn() } as unknown as ChatRateLimit,
      eventos as unknown as ChatEvents,
      {} as RespuestasFijas,
      {} as AsistenteDelChat,
    );
    const corrida = nuevaCorrida();

    const n = await dentroDeCorrida(corrida, () =>
      servicio.cerrarInactivos(AHORA, 24),
    );

    expect(n).toBe(1);
    expect(cerrados).toEqual(['b-chat']);
    expect(chats['a-chat'].status).toBe(ConversationStatus.OPEN);
    expect(corrida).toMatchObject({
      errors: 1,
      fatal: null,
      lastError: 'fila de A rota',
    });
    expect([...corrida.elementos.fallidos.keys()]).toEqual(['chat:a-chat']);
    expect([...corrida.elementos.bien]).toEqual(['chat:b-chat']);
  });
});
