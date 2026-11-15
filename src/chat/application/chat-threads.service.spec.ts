import type { DataSource } from 'typeorm';
import { Channel, Party } from '../domain/chat.enums';
import { ConversacionNoEncontradaError } from '../domain/chat.errors';
import type { Conversation } from '../entities/conversation.entity';
import type { ChatEvents } from './chat.events';
import { ChatThreadsService } from './chat-threads.service';

/** Query builder que anota las condiciones y devuelve las filas dadas. */
function qbFalso(filas: unknown[]) {
  const condiciones: string[] = [];
  const qb = {
    where: (c: string) => (condiciones.push(c), qb),
    andWhere: (c: string) => (condiciones.push(c), qb),
    orderBy: () => qb,
    take: () => qb,
    getMany: () => Promise.resolve(filas),
  };
  return { qb, condiciones };
}

const conv = {
  conversationId: 'hilo-1',
  distributorId: 'dist-a',
  channel: Channel.PLATFORM_TICKET,
  lastMessageSeq: 10,
} as Conversation;

describe('ChatThreadsService', () => {
  it('a la empresa nunca le trae notas internas; a la plataforma, sí', async () => {
    const empresa = qbFalso([]);
    const plataforma = qbFalso([]);
    let llamada = 0;
    const ds = {
      getRepository: () => ({
        createQueryBuilder: () =>
          llamada++ === 0 ? empresa.qb : plataforma.qb,
      }),
    } as unknown as DataSource;
    const s = new ChatThreadsService(ds, {} as ChatEvents);
    await s.mensajes(
      conv,
      { party: Party.COMPANY, userId: 'a' },
      { limit: 50 },
    );
    await s.mensajes(
      conv,
      { party: Party.PLATFORM, userId: 's' },
      { limit: 50 },
    );
    expect(empresa.condiciones).toContain('m.visibility = :todos');
    expect(plataforma.condiciones).not.toContain('m.visibility = :todos');
  });

  it('pagina hacia atrás y devuelve en orden de seq, con hasMore', async () => {
    const filas = [5, 4, 3].map((seq) => ({ seq }));
    const { qb } = qbFalso(filas);
    const ds = {
      getRepository: () => ({ createQueryBuilder: () => qb }),
    } as unknown as DataSource;
    const s = new ChatThreadsService(ds, {} as ChatEvents);
    const r = await s.mensajes(
      conv,
      { party: Party.PLATFORM, userId: 's' },
      { limit: 2, beforeSeq: 6 },
    );
    expect(r).toEqual({ items: [{ seq: 4 }, { seq: 5 }], hasMore: true });
  });

  it('afterSeq y beforeSeq juntos es 400', async () => {
    const s = new ChatThreadsService({} as DataSource, {} as ChatEvents);
    await expect(
      s.mensajes(
        conv,
        { party: Party.PLATFORM, userId: 's' },
        { limit: 2, afterSeq: 1, beforeSeq: 6 },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('una conversación de otra empresa es 404: se busca con la empresa de quien pide', async () => {
    let where: unknown;
    const manager = {
      getRepository: () => ({
        findOne: (o: { where: unknown }) => {
          where = o.where;
          return Promise.resolve(null);
        },
      }),
    };
    const s = new ChatThreadsService(
      { manager } as unknown as DataSource,
      {} as ChatEvents,
    );
    await expect(
      s.buscar({
        conversationId: 'chat-de-a',
        channel: Channel.PLATFORM_CHAT,
        distributorId: 'dist-b',
      }),
    ).rejects.toBeInstanceOf(ConversacionNoEncontradaError);
    expect(where).toEqual({
      conversationId: 'chat-de-a',
      channel: Channel.PLATFORM_CHAT,
      distributorId: 'dist-b',
    });
  });

  it('leer no pasa del último mensaje y avisa sólo si subió la persona o la punta', async () => {
    const consultas: unknown[][] = [];
    let personal: unknown = [[{ last_read_seq: 10 }], 1];
    let punta: unknown = [[{ last_read_seq: 10 }], 1];
    const manager = {
      query: (sql: string, p: unknown[]) => {
        consultas.push(p);
        return Promise.resolve(
          sql.includes('conversation_read_state') ? personal : punta,
        );
      },
    };
    const ds = {
      transaction: <T>(fn: (m: typeof manager) => Promise<T>) => fn(manager),
    } as unknown as DataSource;
    const eventos = { lectura: jest.fn() };
    const s = new ChatThreadsService(ds, eventos as unknown as ChatEvents);
    await s.leer(conv, { party: Party.COMPANY, userId: 'a' }, 99);
    // B4: otra persona de la empresa ya había leído más (la punta no sube),
    // pero la lectura de esta persona sí: sus otras pestañas se enteran.
    punta = [[], 0];
    await s.leer(conv, { party: Party.COMPANY, userId: 'a2' }, 10);
    personal = [[], 0];
    await s.leer(conv, { party: Party.COMPANY, userId: 'a' }, 5);
    expect(consultas[0]).toEqual(['hilo-1', 'a', 'dist-a', 10]);
    expect(eventos.lectura.mock.calls).toEqual([
      [
        {
          conversationId: 'hilo-1',
          distributorId: 'dist-a',
          party: Party.COMPANY,
          lastReadSeq: 10,
          userId: 'a',
          personal: true,
          deLaParte: true,
        },
      ],
      [
        {
          conversationId: 'hilo-1',
          distributorId: 'dist-a',
          party: Party.COMPANY,
          lastReadSeq: 10,
          userId: 'a2',
          personal: true,
          deLaParte: false,
        },
      ],
    ]);
  });
});
