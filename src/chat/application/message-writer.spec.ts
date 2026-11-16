import { randomUUID } from 'crypto';
import type { EntityManager } from 'typeorm';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
  SystemCode,
} from '../domain/chat.enums';
import {
  ConversacionCerradaError,
  ConversacionNoEncontradaError,
  NotaInternaNoPermitidaError,
  RespuestaInvalidaError,
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
  /** Lo que pidió cada envío a `siguienteSeq`: si el mensaje lo ve la otra punta. */
  readonly visibles: boolean[] = [];
  /** La vista previa que pidió guardar cada envío en la conversación. */
  readonly vistasPrevias: Array<string | null> = [];
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

  mensajePorSeq(
    _m: EntityManager,
    conversationId: string,
    seq: number,
  ): Promise<Message | null> {
    return Promise.resolve(
      this.mensajes.find(
        (m) => m.conversationId === conversationId && m.seq === seq,
      ) ?? null,
    );
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
    vistaPrevia: string | null,
    visible = true,
  ): Promise<number> {
    this.visibles.push(visible);
    this.vistasPrevias.push(vistaPrevia);
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

describe('MessageWriter: notas internas de la bandeja (4a)', () => {
  let base: BaseEnMemoria;
  let writer: MessageWriter;
  const enviar = (n: NuevoMensaje) =>
    base.transaccion((m) => writer.escribir(m, n));

  beforeEach(() => {
    base = new BaseEnMemoria();
    base.conversaciones.set(
      'c3',
      conversacion('c3', { channel: Channel.STAFF_CUSTOMER }),
    );
    base.conversaciones.set(
      'c2',
      conversacion('c2', { channel: Channel.STAFF_DRIVER }),
    );
    writer = new MessageWriter(base);
  });

  it.each([Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER])(
    'el personal deja una nota en la bandeja (%s): no mueve la lista de la otra punta',
    async (canal) => {
      const id = canal === Channel.STAFF_CUSTOMER ? 'c3' : 'c2';
      const r = await enviar(
        texto(id, { visibility: MessageVisibility.INTERNAL }),
      );
      expect(r.message).toMatchObject({ seq: 1, visibility: 'internal' });
      expect(base.visibles).toEqual([false]);
    },
  );

  it('un mensaje visible sí mueve la lista', async () => {
    await enviar(texto('c3'));
    expect(base.visibles).toEqual([true]);
  });

  it.each<[string, string, Partial<NuevoMensaje>]>([
    ['del cliente', 'c3', { senderParty: Party.CUSTOMER, senderUserId: 'cli' }],
    ['del chofer', 'c2', { senderParty: Party.DRIVER, senderUserId: 'cho' }],
    [
      'del sistema que no es la nota de derivación (auto_reply)',
      'c3',
      {
        senderParty: Party.SYSTEM,
        senderUserId: null,
        kind: MessageKind.AUTO_REPLY,
      },
    ],
  ])(
    'una nota %s no se admite (400) y no gasta número',
    async (_caso, id, extra) => {
      await expect(
        enviar(texto(id, { visibility: MessageVisibility.INTERNAL, ...extra })),
      ).rejects.toBeInstanceOf(NotaInternaNoPermitidaError);
      expect(base.conversaciones.get(id)!.lastMessageSeq).toBe(0);
    },
  );

  it('la nota de derivación del asistente va en C3 y no en C2', async () => {
    const nota = (id: string) =>
      texto(id, {
        senderParty: Party.SYSTEM,
        senderUserId: null,
        clientMessageId: null,
        kind: MessageKind.SYSTEM,
        systemCode: SystemCode.HANDOFF_NOTE,
        visibility: MessageVisibility.INTERNAL,
      });
    expect((await enviar(nota('c3'))).message.seq).toBe(1);
    await expect(enviar(nota('c2'))).rejects.toBeInstanceOf(
      NotaInternaNoPermitidaError,
    );
  });

  it('la empresa no deja notas en su chat con la plataforma (C1)', async () => {
    base.conversaciones.set('c1', conversacion('c1'));
    await expect(
      enviar(texto('c1', { visibility: MessageVisibility.INTERNAL })),
    ).rejects.toBeInstanceOf(NotaInternaNoPermitidaError);
  });

  it('un mensaje que ve la otra punta no responde a una nota: 400 y no gasta número', async () => {
    await enviar(texto('c3', { visibility: MessageVisibility.INTERNAL }));
    await expect(enviar(texto('c3', { replyToSeq: 1 }))).rejects.toBeInstanceOf(
      RespuestaInvalidaError,
    );
    expect(base.conversaciones.get('c3')!.lastMessageSeq).toBe(1);
    // Sí responde a un mensaje visible.
    await enviar(texto('c3'));
    expect((await enviar(texto('c3', { replyToSeq: 2 }))).message.seq).toBe(3);
  });
});

describe('MessageWriter: adjuntos (CH7)', () => {
  it('un adjunto guarda «📎 Foto»/«📎 Archivo» como vista previa, no su epígrafe; responderle lo cita igual', async () => {
    const base = new BaseEnMemoria();
    base.conversaciones.set(
      'c3',
      conversacion('c3', { channel: Channel.STAFF_CUSTOMER }),
    );
    const writer = new MessageWriter(base);
    const enviar = (n: NuevoMensaje) =>
      base.transaccion((m) => writer.escribir(m, n));
    const foto = await enviar(
      texto('c3', {
        kind: MessageKind.ATTACHMENT,
        body: 'La puerta de casa',
        payload: { media: 'photo' },
      }),
    );
    await enviar(
      texto('c3', {
        kind: MessageKind.ATTACHMENT,
        body: null,
        payload: { media: 'file' },
      }),
    );
    expect(base.vistasPrevias).toEqual(['📎 Foto', '📎 Archivo']);
    const respuesta = await enviar(
      texto('c3', { replyToSeq: foto.message.seq }),
    );
    expect(respuesta.message.replyToPreview).toBe('📎 Foto');
  });
});
