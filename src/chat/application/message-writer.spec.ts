import { randomUUID } from 'crypto';
import type { EntityManager } from 'typeorm';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
} from '../domain/chat.enums';
import {
  ConversacionCerradaError,
  ConversacionNoEncontradaError,
  NotaInternaNoPermitidaError,
} from '../domain/chat.errors';
import type { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';
import { MessageWriter } from './message-writer';
import { MensajesRepositorio, NuevoMensaje } from './mensajes.port';

/**
 * Base en memoria que se porta como Postgres en lo que importa al envío:
 *  - `bloquearConversacion` toma un cerrojo de fila que se suelta al terminar
 *    la transacción (`FOR UPDATE`);
 *  - `siguienteSeq` lee, espera y escribe (no es atómico por sí solo: si
 *    quien llama no tiene la fila bloqueada, dos envíos leen el mismo valor);
 *  - una transacción que falla deshace sus cambios (contador y mensajes).
 */
class BaseEnMemoria extends MensajesRepositorio {
  readonly conversaciones = new Map<string, Conversation>();
  readonly mensajes: Message[] = [];
  private readonly cerrojos = new Map<string, Promise<void>>();
  private readonly liberar = new Map<EntityManager, Array<() => void>>();
  private readonly deshacer = new Map<EntityManager, Array<() => void>>();
  /** Para simular una falla después de asignar el número. */
  fallarAlInsertar: (m: NuevoMensaje) => boolean = () => false;

  async transaccion<T>(fn: (m: EntityManager) => Promise<T>): Promise<T> {
    const manager = {} as EntityManager;
    this.liberar.set(manager, []);
    this.deshacer.set(manager, []);
    try {
      return await fn(manager);
    } catch (error) {
      for (const paso of (this.deshacer.get(manager) ?? []).reverse()) paso();
      throw error;
    } finally {
      for (const soltar of this.liberar.get(manager) ?? []) soltar();
      this.liberar.delete(manager);
      this.deshacer.delete(manager);
    }
  }

  async bloquearConversacion(
    manager: EntityManager,
    conversationId: string,
    distributorId: string,
  ): Promise<Conversation | null> {
    const previo = this.cerrojos.get(conversationId) ?? Promise.resolve();
    let soltar!: () => void;
    const propio = new Promise<void>((r) => (soltar = r));
    this.cerrojos.set(
      conversationId,
      previo.then(() => propio),
    );
    await previo;
    this.liberar.get(manager)?.push(soltar);
    const c = this.conversaciones.get(conversationId);
    if (!c || c.distributorId !== distributorId) return null;
    return { ...c };
  }

  async buscarPorClientId(
    _m: EntityManager,
    conversationId: string,
    senderUserId: string,
    clientMessageId: string,
  ): Promise<Message | null> {
    await tic();
    return (
      this.mensajes.find(
        (m) =>
          m.conversationId === conversationId &&
          m.senderUserId === senderUserId &&
          m.clientMessageId === clientMessageId,
      ) ?? null
    );
  }

  async siguienteSeq(
    manager: EntityManager,
    conversation: Conversation,
  ): Promise<number> {
    const fila = this.conversaciones.get(conversation.conversationId)!;
    const leido = fila.lastMessageSeq;
    await tic();
    fila.lastMessageSeq = leido + 1;
    this.deshacer.get(manager)?.push(() => {
      fila.lastMessageSeq = leido;
    });
    return leido + 1;
  }

  async insertar(
    manager: EntityManager,
    mensaje: NuevoMensaje & { seq: number },
  ): Promise<Message> {
    await tic();
    if (this.fallarAlInsertar(mensaje)) {
      throw new Error('falla simulada de la base');
    }
    const fila = {
      ...mensaje,
      messageId: randomUUID(),
      createdAt: new Date(),
    } as unknown as Message;
    this.mensajes.push(fila);
    this.deshacer.get(manager)?.push(() => {
      this.mensajes.splice(this.mensajes.indexOf(fila), 1);
    });
    return fila;
  }
}

const tic = () => new Promise<void>((r) => setImmediate(r));

const EMPRESA = 'dist-a';
const OTRA = 'dist-b';

function conversacion(
  id: string,
  extra: Partial<Conversation> = {},
): Conversation {
  return {
    conversationId: id,
    distributorId: EMPRESA,
    channel: Channel.PLATFORM_CHAT,
    status: ConversationStatus.OPEN,
    lastMessageSeq: 0,
    ...extra,
  } as Conversation;
}

function texto(
  conversationId: string,
  extra: Partial<NuevoMensaje> = {},
): NuevoMensaje {
  return {
    conversationId,
    distributorId: EMPRESA,
    senderParty: Party.COMPANY,
    senderUserId: 'admin-a',
    clientMessageId: randomUUID(),
    kind: MessageKind.TEXT,
    visibility: MessageVisibility.ALL,
    body: 'Hola',
    payload: null,
    systemCode: null,
    templateKey: null,
    ...extra,
  };
}

describe('MessageWriter: numeración e idempotencia (§7.4)', () => {
  let base: BaseEnMemoria;
  let writer: MessageWriter;

  beforeEach(() => {
    base = new BaseEnMemoria();
    base.conversaciones.set('c1', conversacion('c1'));
    writer = new MessageWriter(base);
  });

  const enviar = (n: NuevoMensaje) =>
    base.transaccion((m) => writer.escribir(m, n));

  it('50 envíos simultáneos reciben 1..50, sin huecos ni repetidos', async () => {
    const resultados = await Promise.all(
      Array.from({ length: 50 }, () => enviar(texto('c1'))),
    );
    const seqs = resultados.map((r) => r.message.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(base.conversaciones.get('c1')!.lastMessageSeq).toBe(50);
  });

  it('una transacción que falla no gasta su número: los que siguen no dejan hueco', async () => {
    const fallido = randomUUID();
    base.fallarAlInsertar = (m) => m.clientMessageId === fallido;
    const intentos = await Promise.allSettled([
      enviar(texto('c1')),
      enviar(texto('c1', { clientMessageId: fallido })),
      enviar(texto('c1')),
      enviar(texto('c1')),
    ]);
    const estados = intentos.map((r) => r.status);
    const seqs = base.mensajes.map((m) => m.seq).sort((a, b) => a - b);
    expect({ estados, seqs }).toEqual({
      estados: ['fulfilled', 'rejected', 'fulfilled', 'fulfilled'],
      seqs: [1, 2, 3],
    });
  });

  it('el mismo clientMessageId repetido devuelve el mismo mensaje sin gastar número', async () => {
    const n = texto('c1');
    const primero = await enviar(n);
    const segundo = await enviar({ ...n, body: 'Otra cosa' });
    expect(segundo).toMatchObject({ created: false });
    expect(segundo.message.messageId).toBe(primero.message.messageId);
    expect(segundo.message.seq).toBe(1);
    expect(base.conversaciones.get('c1')!.lastMessageSeq).toBe(1);
  });

  it('dos reintentos simultáneos con el mismo clientMessageId escriben uno solo', async () => {
    const n = texto('c1');
    const [a, b] = await Promise.all([enviar(n), enviar(n)]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.message.messageId).toBe(b.message.messageId);
    expect(base.mensajes).toHaveLength(1);
  });

  it('el mismo clientMessageId de otro autor es otro mensaje', async () => {
    const n = texto('c1');
    await enviar(n);
    const otro = await enviar({ ...n, senderUserId: 'admin-a2' });
    expect(otro).toMatchObject({ created: true });
    expect(otro.message.seq).toBe(2);
  });

  it('una conversación de otra empresa es 404 (no se revela que existe)', async () => {
    await expect(
      enviar(texto('c1', { distributorId: OTRA })),
    ).rejects.toBeInstanceOf(ConversacionNoEncontradaError);
    expect(base.mensajes).toHaveLength(0);
  });

  it('una conversación cerrada es 409, pero el reintento de un mensaje ya escrito devuelve el mismo', async () => {
    const n = texto('c1');
    await enviar(n);
    base.conversaciones.get('c1')!.status = ConversationStatus.CLOSED;
    await expect(enviar(texto('c1'))).rejects.toBeInstanceOf(
      ConversacionCerradaError,
    );
    await expect(enviar(n)).resolves.toMatchObject({ created: false });
  });

  it('una nota interna fuera del hilo de un ticket es 400 y no gasta número', async () => {
    await expect(
      enviar(
        texto('c1', {
          senderParty: Party.PLATFORM,
          visibility: MessageVisibility.INTERNAL,
        }),
      ),
    ).rejects.toBeInstanceOf(NotaInternaNoPermitidaError);
    expect(base.conversaciones.get('c1')!.lastMessageSeq).toBe(0);
  });

  it('una nota interna de la plataforma en el hilo de un ticket se escribe', async () => {
    base.conversaciones.set(
      't1',
      conversacion('t1', { channel: Channel.PLATFORM_TICKET }),
    );
    const r = await enviar(
      texto('t1', {
        senderParty: Party.PLATFORM,
        senderUserId: 'super',
        visibility: MessageVisibility.INTERNAL,
      }),
    );
    expect(r.message).toMatchObject({ seq: 1, visibility: 'internal' });
  });
});
