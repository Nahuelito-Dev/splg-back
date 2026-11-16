import type { DataSource } from 'typeorm';
import type { AssistantFaqService } from '../assistant/assistant-faq.service';
import { AsistenteDelChat } from '../chat/application/asistente-del-chat';
import type { ChatEvents, Efectos } from '../chat/application/chat.events';
import type { ChatViewsService } from '../chat/application/chat-views.service';
import {
  ajustesDeLaBandejaPorDefecto,
  type CompanyChatSettingsService,
} from '../chat/application/company-chat-settings.service';
import type { MessageWriter } from '../chat/application/message-writer';
import type { NuevoMensaje } from '../chat/application/mensajes.port';
import { RespuestasFijas } from '../chat/application/respuestas-fijas';
import {
  configuracionPorDefecto,
  type SupportSettingsService,
} from '../chat/application/support-settings.service';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
  SubjectType,
} from '../chat/domain/chat.enums';
import { ConversacionCerradaError } from '../chat/domain/chat.errors';
import type { ChatCompanySettings } from '../chat/entities/chat-company-settings.entity';
import { Conversation } from '../chat/entities/conversation.entity';
import { Message } from '../chat/entities/message.entity';
import type { AccesoDeLaEmpresa } from '../platform/access/acceso-de-la-empresa.service';
import {
  dentroDeCorrida,
  nuevaCorrida,
} from '../process-run/process-run.context';
import type { RedisService } from '../redis/redis.service';
import {
  MotivoDeDerivacion,
  type RespuestaDelModelo,
  TOPE_DEL_RESCATE,
  TOPE_DEL_RESCATE_POR_EMPRESA,
} from './asistente-ia.dominio';
import {
  AsistenteIaService,
  perfilSiCorresponde,
  PLANTILLA_DE_DERIVACION,
  PLANTILLA_DEL_ASISTENTE,
} from './asistente-ia.service';
import type {
  ConsultaAlAsistente,
  ConsultaAlModelo,
} from './consulta-al-modelo';
import { AssistantTrace } from './entities/assistant-trace.entity';
import type { HerramientasDelAsistente } from './herramientas';

const EMPRESA = 'dist-a';
const CLIENTE = 'cli-1';
const CONV = 'conv-1';
/** Martes 10/11/2026, 12:00 en Buenos Aires. */
const AHORA = new Date('2026-11-10T15:00:00Z');
const hace = (min: number) => new Date(AHORA.getTime() - min * 60_000);
/** Atiende sólo los lunes de 9 a 18: el martes a las 12 está cerrada. */
const CERRADA = [{ weekday: 1, opensAt: '09:00', closesAt: '18:00' }];

const USO = {
  inputTokens: 120,
  outputTokens: 30,
  cacheReadTokens: 900,
  cacheCreationTokens: 0,
};
const RESPUESTA: RespuestaDelModelo = {
  tipo: 'respuesta',
  texto: 'Abrimos de 8 a 12.',
  modelo: 'claude-haiku-5-5',
  uso: USO,
  herramientas: ['horarios_y_zonas'],
};
const derivacion = (
  motivo: MotivoDeDerivacion,
  modelo: string | null = 'claude-haiku-5-5',
): RespuestaDelModelo => ({
  tipo: 'derivar',
  motivo,
  modelo,
  uso: modelo
    ? USO
    : { ...USO, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  herramientas: [],
});

/** Una fila del hilo como la devuelve la consulta de `AsistenteDelChat` (orden real por `seq`). */
interface Fila {
  seq: number;
  message_id: string;
  sender_party: Party;
  kind: MessageKind;
  de_la_ia: boolean;
  created_at: Date;
  retirado: boolean;
}
const fila = (
  seq: number,
  party: Party,
  creado: Date,
  extra: Partial<Fila> = {},
): Fila => ({
  seq,
  message_id: `msg-${seq}`,
  sender_party: party,
  kind: MessageKind.TEXT,
  de_la_ia: false,
  created_at: creado,
  retirado: false,
  ...extra,
});

interface Traza {
  conversationId: string;
  channel: string;
  distributorId: string;
  triggerMessageId: string;
  outcome: string;
  reason: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  replyMessageId: string | null;
}

interface Opciones {
  canal?: Channel;
  /** La conversación como está al atender y al publicar (si cambió en el medio). */
  conversacion?: Partial<Conversation> | null;
  alPublicar?: Partial<Conversation> | null;
  /** Filas del hilo antes de consultar y al publicar (por omisión, las mismas). */
  filas?: Fila[];
  filasAlPublicar?: Fila[];
  trazas?: Traza[];
  tokensDelMes?: string | null;
  /** En el soporte, los tokens del mes de la empresa que pregunta. */
  tokensDeLaEmpresa?: string | null;
  empresaPrendida?: boolean;
  moduloHabilitado?: boolean;
  chatDeClientes?: boolean;
  soportePrendido?: boolean;
  horario?: typeof CERRADA;
  handoff?: string;
  persona?: string | null;
  resultado?: RespuestaDelModelo;
  lock?: boolean;
  falloAlEscribir?: Error;
  /** Empresas con el interruptor prendido (para apagar las que perdieron la función). */
  empresasPrendidas?: string[];
  /** El alta de la traza publicada falla (dentro de la transacción). */
  insertFalla?: Error;
  disparador?: number;
}

function armar(o: Opciones = {}) {
  const canal = o.canal ?? Channel.STAFF_CUSTOMER;
  const seq = o.disparador ?? 5;
  const c1 = canal === Channel.PLATFORM_CHAT;
  const base = Object.assign(new Conversation(), {
    conversationId: CONV,
    distributorId: EMPRESA,
    channel: canal,
    subjectType: SubjectType.GENERAL,
    status: ConversationStatus.OPEN,
    assignedToUserId: null,
    awaitingHumanSince: null,
    customerUserId: c1 ? null : CLIENTE,
    driverUserId: null,
    orderId: null,
    lastMessageSeq: seq,
  });
  const pregunta = c1 ? Party.COMPANY : Party.CUSTOMER;
  const filas = o.filas ?? [
    fila(seq - 2, pregunta, hace(400)),
    fila(seq, pregunta, AHORA, { message_id: `msg-${seq}` }),
  ];
  let publicando = false;
  const trazas: Traza[] = [...(o.trazas ?? [])];
  const actualizaciones: unknown[][] = [];
  /** Lo que la base guardó de la conversación (la espera de persona, al derivar). */
  const guardado: Partial<Conversation> = {};
  const conversacionActual = (): Conversation | null =>
    o.conversacion === null || (publicando && o.alPublicar === null)
      ? null
      : Object.assign(new Conversation(), base, o.conversacion, {
          ...guardado,
          ...(publicando ? o.alPublicar : {}),
        });
  const insertar = jest.fn((t: Traza) => {
    if (publicando && o.insertFalla) return Promise.reject(o.insertFalla);
    trazas.push(t);
    return Promise.resolve({});
  });
  const manager = {
    getRepository: jest.fn((e: unknown) =>
      e === AssistantTrace
        ? { insert: insertar }
        : e === Message
          ? { findOne: jest.fn(() => Promise.resolve(mensaje())) }
          : { findOne: jest.fn(() => Promise.resolve(conversacionActual())) },
    ),
    query: jest.fn((sql: string, params: unknown[] = []) => {
      if (
        sql.includes(
          'FROM "chat_company_settings" WHERE "assistant_ai_enabled"',
        )
      ) {
        return Promise.resolve(
          (o.empresasPrendidas ?? []).map((id) => ({ distributor_id: id })),
        );
      }
      if (sql.includes('"de_la_ia"')) {
        return Promise.resolve(
          publicando ? (o.filasAlPublicar ?? filas) : filas,
        );
      }
      if (sql.includes('AS fuera') || sql.includes('AS recibido')) {
        return Promise.resolve([
          { fuera: false, recibido: false, empresa: false, plataforma: false },
        ]);
      }
      if (sql.includes('"full_name"')) {
        return Promise.resolve([
          {
            persona: o.persona === undefined ? 'María López' : o.persona,
            empresa: 'Florchi Gas',
          },
        ]);
      }
      if (sql.includes('UPDATE "conversation"')) {
        actualizaciones.push(params);
        guardado.awaitingHumanSince = params[1] as Date;
      }
      return Promise.resolve([]);
    }),
  };
  const dataSource = {
    manager,
    getRepository: manager.getRepository,
    query: jest.fn((sql: string, params: unknown[] = []) => {
      if (sql.includes('count(*)')) {
        return Promise.resolve([
          {
            n: trazas.filter(
              (t) => t.conversationId === params[0] && t.model !== null,
            ).length,
          },
        ]);
      }
      if (sql.includes('AS hay')) {
        return Promise.resolve([
          {
            hay: trazas.some(
              (t) =>
                t.triggerMessageId === params[0] && t.outcome !== 'discarded',
            ),
          },
        ]);
      }
      if (sql.includes('sum(')) {
        return Promise.resolve([
          {
            n: o.tokensDelMes === undefined ? '0' : o.tokensDelMes,
            empresa:
              o.tokensDeLaEmpresa === undefined ? '0' : o.tokensDeLaEmpresa,
          },
        ]);
      }
      if (sql.includes('JOIN "message" m')) {
        // Los candidatos del rescate, con las condiciones del SQL sobre el estado del doble.
        const conv = conversacionActual();
        const ultima = [...filas].sort((a, b) => b.seq - a.seq)[0];
        const corresponde =
          conv !== null &&
          conv.status === ConversationStatus.OPEN &&
          !conv.assignedToUserId &&
          !conv.awaitingHumanSince &&
          ultima?.sender_party === pregunta &&
          ultima.kind === MessageKind.TEXT &&
          !ultima.retirado &&
          ultima.created_at < (params[0] as Date) &&
          ultima.created_at >= (params[1] as Date) &&
          (c1 ? params[2] === true : ajustes.assistantAiEnabled) &&
          !trazas.some(
            (t) =>
              t.triggerMessageId === ultima.message_id &&
              t.outcome !== 'discarded',
          );
        return Promise.resolve(
          corresponde
            ? [{ conversation_id: CONV, message_id: ultima.message_id }]
            : [],
        );
      }
      if (sql.includes('"body" FROM "message"')) {
        return Promise.resolve([
          {
            sender_party: pregunta,
            kind: MessageKind.TEXT,
            body: '¿A qué hora abren?',
          },
        ]);
      }
      return Promise.resolve([]);
    }),
    transaction: jest.fn(
      async (cb: (m: typeof manager) => Promise<unknown>) => {
        publicando = true;
        try {
          return await cb(manager);
        } finally {
          publicando = false;
        }
      },
    ),
  };
  const redis = {
    withLock: jest.fn(
      async (_k: string, _ttl: number, fn: () => Promise<unknown>) =>
        o.lock === false
          ? { obtenido: false }
          : { obtenido: true, valor: await fn() },
    ),
  };
  const acceso = {
    habilitado: jest.fn<Promise<boolean>, [string]>(() =>
      Promise.resolve(o.moduloHabilitado ?? true),
    ),
  };
  const ajustes = Object.assign(ajustesDeLaBandejaPorDefecto(EMPRESA), {
    assistantAiEnabled: o.empresaPrendida ?? true,
    customerChatEnabled: o.chatDeClientes ?? true,
    assistantName: 'Gasito de {{empresa.nombre}}',
    handoffMessage: o.handoff ?? 'Ya te paso con alguien, {{cliente.nombre}}.',
    businessHours: o.horario ?? [],
    outOfHoursEnabled: true,
  }) as ChatCompanySettings;
  const ajustesDeLaEmpresa = {
    leer: jest.fn(() => Promise.resolve(ajustes)),
    nombreDeLaEmpresa: jest.fn(() => Promise.resolve('Florchi Gas')),
  };
  const soporte = Object.assign(configuracionPorDefecto(), {
    assistantAiEnabled: o.soportePrendido ?? true,
    assistantRepliesPerConversation: 10,
    assistantMonthlyTokenLimit: 100_000,
    assistantMonthlyTokenLimitPerCompany: 20_000,
    chatHours: o.horario ?? [],
  });
  const ajustesDelSoporte = { leer: jest.fn(() => Promise.resolve(soporte)) };
  const vistas = { nombreDeLaPlataforma: jest.fn(() => 'OrixTech') };
  const faqs = {
    listar: jest.fn(() =>
      Promise.resolve({
        items: [{ question: '¿Horario?', answer: 'De 8 a 12.', position: 1 }],
        version: 3,
      }),
    ),
  };
  const escritos: NuevoMensaje[] = [];
  const escribir = jest.fn((_m: unknown, nuevo: NuevoMensaje) => {
    if (o.falloAlEscribir) return Promise.reject(o.falloAlEscribir);
    escritos.push(nuevo);
    return Promise.resolve({
      message: { ...nuevo, messageId: `resp-${escritos.length}`, seq: 6 },
      created: true,
      conversation: Object.assign(new Conversation(), base),
    });
  });
  const writer = { escribir } as unknown as MessageWriter;
  const publicados: Efectos[] = [];
  const eventos = {
    publicar: jest.fn((e: Efectos) => {
      publicados.push(e);
    }),
  };
  const consultar = jest.fn<Promise<RespuestaDelModelo>, [ConsultaAlModelo]>(
    () => Promise.resolve(o.resultado ?? RESPUESTA),
  );
  const herramientas = {
    ejecutar: jest.fn(() => Promise.resolve({ datos: [], error: false })),
  };
  const chat = new AsistenteDelChat(
    acceso as unknown as AccesoDeLaEmpresa,
    ajustesDeLaEmpresa as unknown as CompanyChatSettingsService,
    ajustesDelSoporte as unknown as SupportSettingsService,
  );
  const fijas = new RespuestasFijas(
    writer,
    ajustesDeLaEmpresa as unknown as CompanyChatSettingsService,
    ajustesDelSoporte as unknown as SupportSettingsService,
    vistas as unknown as ChatViewsService,
  );
  const servicio = new AsistenteIaService(
    dataSource as unknown as DataSource,
    redis as unknown as RedisService,
    chat,
    ajustesDeLaEmpresa as unknown as CompanyChatSettingsService,
    ajustesDelSoporte as unknown as SupportSettingsService,
    vistas as unknown as ChatViewsService,
    faqs as unknown as AssistantFaqService,
    writer,
    fijas,
    eventos as unknown as ChatEvents,
    { consultar } as unknown as ConsultaAlAsistente,
    herramientas as unknown as HerramientasDelAsistente,
  );
  const mensaje = (n = seq) =>
    ({
      messageId: `msg-${n}`,
      conversationId: CONV,
      distributorId: EMPRESA,
      seq: n,
      senderParty: pregunta,
      kind: MessageKind.TEXT,
      visibility: MessageVisibility.ALL,
      body: '¿A qué hora abren?',
    }) as Message;
  return {
    servicio,
    rescatar: (cuando: Date = AHORA) => servicio.rescatarSinAtender(cuando),
    atender: (n = seq) =>
      servicio.atender(
        { conversation: base, message: mensaje(n) },
        () => AHORA,
      ),
    dataSource,
    manager,
    redis,
    acceso,
    faqs,
    escritos,
    eventos,
    publicados,
    consultar,
    herramientas,
    trazas,
    actualizaciones,
  };
}

describe('AsistenteIaService', () => {
  describe('cuándo contesta', () => {
    it('C3: publica la respuesta automática firmada (nombre de marca, como B1) con el modelo, y la traza con tokens y caché', async () => {
      const t = armar();
      await t.atender();
      expect(t.escritos).toEqual([
        {
          conversationId: CONV,
          distributorId: EMPRESA,
          senderParty: Party.SYSTEM,
          senderUserId: null,
          clientMessageId: null,
          kind: MessageKind.AUTO_REPLY,
          visibility: MessageVisibility.ALL,
          body: 'Abrimos de 8 a 12.',
          payload: {
            senderLabel: 'Gasito de Florchi Gas',
            ai: { model: 'claude-haiku-5-5' },
          },
          systemCode: null,
          templateKey: PLANTILLA_DEL_ASISTENTE,
        },
      ]);
      expect(t.trazas).toEqual([
        expect.objectContaining({
          distributorId: EMPRESA,
          conversationId: CONV,
          channel: Channel.STAFF_CUSTOMER,
          triggerMessageId: 'msg-5',
          replyMessageId: 'resp-1',
          outcome: 'answered',
          reason: null,
          model: 'claude-haiku-5-5',
          inputTokens: 120,
          outputTokens: 30,
          cacheReadTokens: 900,
          cacheCreationTokens: 0,
        }),
      ]);
      expect(t.publicados).toHaveLength(1);
      expect(t.publicados[0].conversaciones).toEqual([]);
      expect(t.redis.withLock).toHaveBeenCalledWith(
        `asistente:${CONV}`,
        expect.any(Number),
        expect.any(Function),
        expect.any(Number),
      );
    });

    it('C3: consulta con la base de ESA empresa y las herramientas reciben la empresa y el cliente de la conversación, nunca del modelo', async () => {
      const t = armar();
      await t.atender();
      expect(t.faqs.listar).toHaveBeenCalledWith(EMPRESA);
      const [consulta] = t.consultar.mock.calls[0];
      expect(consulta.system[1].text).toContain('De 8 a 12.');
      expect(consulta.mensajes).toEqual([
        {
          role: 'user',
          content: [{ type: 'text', text: '¿A qué hora abren?' }],
        },
      ]);
      await consulta.ejecutar('estado_de_mi_pedido', { pedido: 'ABC123' });
      expect(t.herramientas.ejecutar).toHaveBeenCalledWith(
        expect.objectContaining({
          distributorId: EMPRESA,
          customerUserId: CLIENTE,
          orderId: null,
          ahora: AHORA,
        }),
        'estado_de_mi_pedido',
        { pedido: 'ABC123' },
      );
    });

    it('C1: base de la plataforma, sólo pasar_a_persona, firma de la plataforma', async () => {
      const t = armar({ canal: Channel.PLATFORM_CHAT });
      await t.atender();
      expect(t.faqs.listar).toHaveBeenCalledWith(null);
      const [consulta] = t.consultar.mock.calls[0];
      expect(consulta.herramientas.map((h) => h.name)).toEqual([
        'pasar_a_persona',
      ]);
      expect(await consulta.ejecutar('precios_vigentes', {})).toEqual({
        datos: { error: 'Esa herramienta no está disponible acá' },
        error: true,
      });
      expect(t.escritos[0].payload).toEqual({
        senderLabel: 'Asistente de OrixTech',
        ai: { model: 'claude-haiku-5-5' },
      });
      expect(t.acceso.habilitado).not.toHaveBeenCalled();
    });

    it('fuera de horario también contesta la IA (no hay respuesta fija)', async () => {
      const t = armar({ horario: CERRADA });
      await t.atender();
      expect(t.escritos).toHaveLength(1);
      expect(t.escritos[0].templateKey).toBe(PLANTILLA_DEL_ASISTENTE);
    });

    it('si alguien del equipo escribió hace más de 2 h, vuelve a contestar', async () => {
      const t = armar({
        filas: [
          fila(3, Party.COMPANY, hace(121)),
          fila(5, Party.CUSTOMER, AHORA),
        ],
      });
      await t.atender();
      expect(t.consultar).toHaveBeenCalledTimes(1);
    });
  });

  describe('cuándo se calla (sin consultar)', () => {
    it.each<[string, Opciones]>([
      ['alguien la tomó', { conversacion: { assignedToUserId: 'adm-9' } }],
      [
        'ya espera a una persona',
        { conversacion: { awaitingHumanSince: hace(5) } },
      ],
      ['está cerrada', { conversacion: { status: ConversationStatus.CLOSED } }],
      ['no existe', { conversacion: null }],
      [
        'alguien del equipo escribió hace menos de 2 h (aunque no la tomó)',
        {
          filas: [
            fila(3, Party.COMPANY, hace(119)),
            fila(5, Party.CUSTOMER, AHORA),
          ],
        },
      ],
      [
        'hay un mensaje más nuevo de la misma punta',
        {
          filas: [
            fila(5, Party.CUSTOMER, hace(1)),
            fila(6, Party.CUSTOMER, AHORA),
          ],
        },
      ],
      [
        'ya contestó la IA después',
        {
          filas: [
            fila(5, Party.CUSTOMER, hace(1)),
            fila(6, Party.SYSTEM, AHORA, {
              kind: MessageKind.AUTO_REPLY,
              de_la_ia: true,
            }),
          ],
        },
      ],
      [
        'el mensaje se retiró',
        { filas: [fila(5, Party.CUSTOMER, AHORA, { retirado: true })] },
      ],
      [
        'ya hay una respuesta publicada para ese mensaje',
        {
          trazas: [
            {
              conversationId: CONV,
              channel: 'staff_customer',
              distributorId: EMPRESA,
              triggerMessageId: 'msg-5',
              outcome: 'answered',
              reason: null,
              model: 'claude-haiku-5-5',
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              replyMessageId: 'x',
            },
          ],
        },
      ],
    ])('%s', async (_caso, o) => {
      const t = armar(o);
      await t.atender();
      expect(t.consultar).not.toHaveBeenCalled();
      expect(t.escritos).toEqual([]);
      expect(t.eventos.publicar).not.toHaveBeenCalled();
    });

    it.each<[string, Opciones]>([
      ['el interruptor de la empresa apagado', { empresaPrendida: false }],
      ['la función no habilitada para la empresa', { moduloHabilitado: false }],
      ['el chat de clientes apagado', { chatDeClientes: false }],
      [
        'C1 con el interruptor de la plataforma apagado',
        { canal: Channel.PLATFORM_CHAT, soportePrendido: false },
      ],
    ])('%s: ni lock ni consulta', async (_caso, o) => {
      const t = armar(o);
      await t.atender();
      expect(t.redis.withLock).not.toHaveBeenCalled();
      expect(t.consultar).not.toHaveBeenCalled();
    });

    it('el lock lo tiene otro y no se libera a tiempo: no publica ni tira', async () => {
      const t = armar({ lock: false });
      await expect(t.atender()).resolves.toBeUndefined();
      expect(t.consultar).not.toHaveBeenCalled();
    });

    it.each([
      [
        'C2 (chofer)',
        Channel.STAFF_DRIVER,
        Party.DRIVER,
        MessageKind.TEXT,
        MessageVisibility.ALL,
      ],
      [
        'un ticket',
        Channel.PLATFORM_TICKET,
        Party.COMPANY,
        MessageKind.TEXT,
        MessageVisibility.ALL,
      ],
      [
        'un mensaje del equipo en C3',
        Channel.STAFF_CUSTOMER,
        Party.COMPANY,
        MessageKind.TEXT,
        MessageVisibility.ALL,
      ],
      [
        'una respuesta automática',
        Channel.STAFF_CUSTOMER,
        Party.SYSTEM,
        MessageKind.AUTO_REPLY,
        MessageVisibility.ALL,
      ],
      [
        'la plataforma en C1',
        Channel.PLATFORM_CHAT,
        Party.PLATFORM,
        MessageKind.TEXT,
        MessageVisibility.ALL,
      ],
      [
        'una nota interna',
        Channel.PLATFORM_CHAT,
        Party.COMPANY,
        MessageKind.TEXT,
        MessageVisibility.INTERNAL,
      ],
    ])('nunca en %s', (_caso, channel, senderParty, kind, visibility) => {
      expect(
        perfilSiCorresponde(
          { channel },
          { senderParty, kind, visibility, body: 'Hola' },
        ),
      ).toBeNull();
    });

    it('un mensaje sin texto tampoco', () => {
      expect(
        perfilSiCorresponde(
          { channel: Channel.STAFF_CUSTOMER },
          {
            senderParty: Party.CUSTOMER,
            kind: MessageKind.TEXT,
            visibility: MessageVisibility.ALL,
            body: null,
          },
        ),
      ).toBeNull();
    });
  });

  describe('descarta lo consultado si cambió mientras consultaba (y deja la traza con sus tokens)', () => {
    it.each<[string, Opciones, string]>([
      [
        'alguien la tomó',
        { alPublicar: { assignedToUserId: 'adm-9' } },
        'taken',
      ],
      [
        'llegó otro mensaje de la misma punta',
        {
          filasAlPublicar: [
            fila(5, Party.CUSTOMER, hace(1)),
            fila(6, Party.CUSTOMER, AHORA),
          ],
        },
        'superseded',
      ],
      [
        'el cliente retiró o borró el mensaje',
        {
          filasAlPublicar: [fila(5, Party.CUSTOMER, AHORA, { retirado: true })],
        },
        'withdrawn',
      ],
      [
        'alguien del equipo escribió (sin tomarla)',
        {
          filasAlPublicar: [
            fila(5, Party.CUSTOMER, hace(1)),
            fila(6, Party.COMPANY, AHORA),
          ],
        },
        'taken',
      ],
      [
        'la cerraron',
        { alPublicar: { status: ConversationStatus.CLOSED } },
        'closed',
      ],
      ['la dieron de baja', { alPublicar: null }, 'closed'],
      [
        'la cerraron (al escribir)',
        { falloAlEscribir: new ConversacionCerradaError() },
        'closed',
      ],
    ])('%s', async (_caso, o, motivo) => {
      const t = armar(o);
      await t.atender();
      expect(t.consultar).toHaveBeenCalledTimes(1);
      expect(t.eventos.publicar).not.toHaveBeenCalled();
      expect(t.trazas).toEqual([
        expect.objectContaining({
          outcome: 'discarded',
          reason: motivo,
          replyMessageId: null,
          model: 'claude-haiku-5-5',
          inputTokens: 120,
          cacheReadTokens: 900,
        }),
      ]);
    });

    it('otro trabajo ya publicó la respuesta a ese mensaje (único): descarta como duplicada', async () => {
      const t = armar({
        insertFalla: Object.assign(new Error('duplicate key'), {
          code: '23505',
        }),
      });
      await expect(t.atender()).resolves.toBeUndefined();
      expect(t.eventos.publicar).not.toHaveBeenCalled();
      expect(t.trazas).toEqual([
        expect.objectContaining({ outcome: 'discarded', reason: 'duplicate' }),
      ]);
    });

    it('mensajes cada 3 s no gastan sin límite: el tope por conversación cuenta las consultas descartadas', async () => {
      const trazas: Traza[] = [];
      let consultas = 0;
      for (let k = 0; k < 15; k += 1) {
        const n = 5 + k;
        // Mientras consulta llega el siguiente mensaje: se descarta.
        const t = armar({
          disparador: n,
          trazas,
          filas: [fila(n, Party.CUSTOMER, AHORA)],
          filasAlPublicar: [
            fila(n, Party.CUSTOMER, hace(0.05)),
            fila(n + 1, Party.CUSTOMER, AHORA),
          ],
        });
        await t.atender(n);
        consultas += t.consultar.mock.calls.length;
        trazas.splice(0, trazas.length, ...t.trazas);
      }
      expect(consultas).toBe(10);
      expect(trazas.filter((x) => x.outcome === 'discarded')).toHaveLength(10);
      // Desde la 11.ª, el tope deriva sin consultar (y sin tokens).
      expect(trazas.slice(10).every((x) => x.model === null)).toBe(true);
      const tokens = trazas.reduce(
        (s, x) => s + x.inputTokens + x.outputTokens + x.cacheReadTokens,
        0,
      );
      expect(tokens).toBe(10 * (120 + 30 + 900));
    });
  });

  describe('derivar', () => {
    it('la IA derivó en horario: el texto de derivación de la empresa con variables, espera a una persona y avisa al equipo', async () => {
      const t = armar({ resultado: derivacion(MotivoDeDerivacion.REFUSAL) });
      await t.atender();
      expect(t.escritos).toEqual([
        expect.objectContaining({
          kind: MessageKind.AUTO_REPLY,
          body: 'Ya te paso con alguien, María.',
          payload: {
            senderLabel: 'Gasito de Florchi Gas',
            ai: { model: 'claude-haiku-5-5', handoff: true },
          },
          templateKey: PLANTILLA_DE_DERIVACION,
        }),
      ]);
      expect(t.actualizaciones).toEqual([[CONV, AHORA]]);
      expect(t.trazas).toEqual([
        expect.objectContaining({
          outcome: 'handed_off',
          reason: 'refusal',
          replyMessageId: 'resp-1',
        }),
      ]);
      expect(t.publicados[0].conversaciones).toEqual([
        {
          conversation: expect.objectContaining({
            awaitingHumanSince: AHORA,
          }) as unknown,
          change: 'status',
        },
      ]);
    });

    it('la IA derivó fuera de horario: agrega cuándo vuelve el equipo', async () => {
      const t = armar({
        horario: CERRADA,
        resultado: derivacion(MotivoDeDerivacion.REQUESTED),
      });
      await t.atender();
      expect(t.escritos[0].body).toBe(
        'Ya te paso con alguien, María. El equipo vuelve a atender el lunes 16/11 a las 09:00.',
      );
    });

    it('si el texto de derivación ya dice cuándo vuelve, no lo repite', async () => {
      const t = armar({
        horario: CERRADA,
        handoff: 'Te contestamos {{horario.proximo}}.',
        resultado: derivacion(MotivoDeDerivacion.REQUESTED),
      });
      await t.atender();
      expect(t.escritos[0].body).toBe(
        'Te contestamos el lunes 16/11 a las 09:00.',
      );
    });

    it('C1: el aviso de la plataforma; fuera de horario, con cuándo vuelve', async () => {
      const enHorario = armar({
        canal: Channel.PLATFORM_CHAT,
        resultado: derivacion(MotivoDeDerivacion.REQUESTED),
      });
      await enHorario.atender();
      expect(enHorario.escritos[0]).toMatchObject({
        body: 'Te paso con alguien del equipo de OrixTech. Te va a responder a la brevedad.',
        payload: { senderLabel: 'Asistente de OrixTech' },
      });
      const fuera = armar({
        canal: Channel.PLATFORM_CHAT,
        horario: CERRADA,
        resultado: derivacion(MotivoDeDerivacion.REQUESTED),
      });
      await fuera.atender();
      expect(fuera.escritos[0].body).toBe(
        'Te paso con alguien del equipo de OrixTech. El equipo vuelve a atender el lunes 16/11 a las 09:00.',
      );
    });

    it('con el texto de derivación vacío después de completar las variables, el de siempre', async () => {
      const t = armar({
        handoff: '{{cliente.nombre}}',
        persona: null,
        resultado: derivacion(MotivoDeDerivacion.NO_TEXT),
      });
      await t.atender();
      expect(t.escritos[0].body).toBe(
        'Te paso con alguien del equipo de Florchi Gas.',
      );
    });
  });

  describe('si la IA no corre (falla o tope): las respuestas fijas de siempre y derivar', () => {
    it('C3 falla la API fuera de horario: sale la fija de fuera de horario (no la derivación) y queda esperando persona', async () => {
      const t = armar({
        horario: CERRADA,
        resultado: derivacion(MotivoDeDerivacion.TIMEOUT, null),
      });
      await t.atender();
      expect(t.escritos).toEqual([
        expect.objectContaining({
          kind: MessageKind.AUTO_REPLY,
          templateKey: 'fuera_de_horario',
          body: 'Ahora estamos fuera de horario. Te respondemos el lunes 16/11 a las 09:00.',
        }),
      ]);
      expect(t.actualizaciones).toEqual([[CONV, AHORA]]);
      expect(t.trazas).toEqual([
        expect.objectContaining({
          outcome: 'handed_off',
          reason: 'timeout',
          replyMessageId: 'resp-1',
          model: null,
        }),
      ]);
    });

    it('C3 falla en horario con el aviso de recibido apagado (no corresponde fija): el aviso de derivación', async () => {
      const t = armar({
        resultado: derivacion(MotivoDeDerivacion.API_ERROR, null),
      });
      await t.atender();
      expect(t.escritos).toEqual([
        expect.objectContaining({ templateKey: PLANTILLA_DE_DERIVACION }),
      ]);
    });

    it('C1 falla: la fija del soporte (recibido en horario)', async () => {
      const t = armar({
        canal: Channel.PLATFORM_CHAT,
        resultado: derivacion(MotivoDeDerivacion.RATE_LIMITED, null),
      });
      await t.atender();
      expect(t.escritos).toEqual([
        expect.objectContaining({
          kind: MessageKind.SYSTEM,
          templateKey: 'recibido',
        }),
      ]);
    });

    it.each<[string, Opciones, MotivoDeDerivacion]>([
      [
        'las consultas por conversación (también las descartadas)',
        {
          trazas: Array.from({ length: 10 }, (_, i) => ({
            conversationId: CONV,
            channel: 'staff_customer',
            distributorId: EMPRESA,
            triggerMessageId: `viejo-${i}`,
            outcome: i % 2 ? 'answered' : 'discarded',
            reason: i % 2 ? null : 'superseded',
            model: 'claude-haiku-5-5',
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            replyMessageId: null,
          })),
        },
        MotivoDeDerivacion.REPLY_LIMIT,
      ],
      [
        'los tokens del mes',
        { tokensDelMes: '100000' },
        MotivoDeDerivacion.MONTHLY_LIMIT,
      ],
    ])(
      'al pasar el tope de %s: no consulta, fija + derivar',
      async (_caso, o, motivo) => {
        const t = armar({ ...o, horario: CERRADA });
        await t.atender();
        expect(t.consultar).not.toHaveBeenCalled();
        expect(t.escritos[0].templateKey).toBe('fuera_de_horario');
        expect(t.trazas.at(-1)).toEqual(
          expect.objectContaining({
            outcome: 'handed_off',
            reason: motivo,
            model: null,
            inputTokens: 0,
          }),
        );
      },
    );

    it('el tope mensual suma la empresa en C3 y todo el soporte en C1 (y aparte la empresa), desde el inicio del mes argentino', async () => {
      const c3 = armar({ tokensDelMes: null });
      await c3.atender();
      const [sql3, params3] = c3.dataSource.query.mock.calls.find(([s]) =>
        s.includes('sum('),
      ) as unknown as [string, unknown[]];
      expect(sql3).toContain('AND "distributor_id" = $2');
      expect(sql3).toContain(
        `date_trunc('month', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')`,
      );
      expect(params3).toEqual([Channel.STAFF_CUSTOMER, EMPRESA]);
      const c1 = armar({ canal: Channel.PLATFORM_CHAT });
      await c1.atender();
      const [sql1, params1] = c1.dataSource.query.mock.calls.find(([s]) =>
        s.includes('sum('),
      ) as unknown as [string, unknown[]];
      // El total es de todo el soporte; lo de la empresa va aparte, con FILTER.
      expect(sql1).not.toContain('AND "distributor_id" = $2');
      expect(sql1).toContain('FILTER (WHERE "distributor_id" = $2)');
      expect(params1).toEqual([Channel.PLATFORM_CHAT, EMPRESA]);
      const [sqlTope] = c3.dataSource.query.mock.calls.find(([s]) =>
        s.includes('count(*)'),
      ) as unknown as [string];
      expect(sqlTope).toContain('"model" IS NOT NULL');
      expect(sqlTope).not.toContain('outcome');
    });
  });

  describe('cupo de cada empresa en el soporte (C1)', () => {
    it('la empresa que agotó su cupo recibe la fija y la derivación aunque la plataforma tenga margen', async () => {
      const t = armar({
        canal: Channel.PLATFORM_CHAT,
        tokensDelMes: '30000',
        tokensDeLaEmpresa: '20000',
      });
      await t.atender();
      expect(t.consultar).not.toHaveBeenCalled();
      expect(t.trazas.at(-1)).toEqual(
        expect.objectContaining({
          outcome: 'handed_off',
          reason: MotivoDeDerivacion.MONTHLY_LIMIT,
          model: null,
        }),
      );
      expect(t.actualizaciones).toHaveLength(1);
    });

    it('otra empresa, con el mismo total del soporte y su cupo libre, sigue con la IA', async () => {
      const t = armar({
        canal: Channel.PLATFORM_CHAT,
        tokensDelMes: '30000',
        tokensDeLaEmpresa: '19999',
      });
      await t.atender();
      expect(t.consultar).toHaveBeenCalledTimes(1);
      expect(t.trazas.at(-1)).toEqual(
        expect.objectContaining({ outcome: 'answered' }),
      );
    });

    it('en C3 el cupo del soporte no aplica: la empresa sólo tiene su tope mensual', async () => {
      const t = armar({ tokensDelMes: '30000', tokensDeLaEmpresa: '99999' });
      await t.atender();
      expect(t.consultar).toHaveBeenCalledTimes(1);
    });
  });

  it('cualquier otro error (base caída, consulta que tira): se registra y no tira', async () => {
    const t = armar({ falloAlEscribir: new Error('se cayó la base') });
    await expect(t.atender()).resolves.toBeUndefined();
    const t2 = armar();
    t2.consultar.mockRejectedValueOnce(new Error('inesperado'));
    await expect(t2.atender()).resolves.toBeUndefined();
    expect(t2.eventos.publicar).not.toHaveBeenCalled();
  });

  describe('rescate de los mensajes que la IA tenía que atender y su trabajo no corrió', () => {
    /** El último mensaje del cliente, de hace 2 minutos, sin nada después (el trabajo se perdió). */
    const perdido = (extra: Opciones = {}) =>
      armar({ filas: [fila(5, Party.CUSTOMER, hace(2))], ...extra });

    it('proceso caído: manda la fija que corresponde y deriva, sin consultar al modelo (traza not_processed)', async () => {
      const t = perdido({ horario: CERRADA });
      expect(await t.rescatar()).toBe(1);
      expect(t.consultar).not.toHaveBeenCalled();
      expect(t.escritos).toEqual([
        expect.objectContaining({
          kind: MessageKind.AUTO_REPLY,
          templateKey: 'fuera_de_horario',
        }),
      ]);
      expect(t.actualizaciones).toEqual([[CONV, AHORA]]);
      expect(t.trazas).toEqual([
        expect.objectContaining({
          triggerMessageId: 'msg-5',
          outcome: 'handed_off',
          reason: 'not_processed',
          model: null,
          inputTokens: 0,
          replyMessageId: 'resp-1',
        }),
      ]);
      expect(t.publicados[0].conversaciones).toEqual([
        expect.objectContaining({ change: 'status' }),
      ]);
      const [sql, params] = t.dataSource.query.mock.calls.find(([q]) =>
        q.includes('JOIN "message" m'),
      ) as unknown as [string, Date[]];
      for (const condicion of [
        'm."seq" = c."last_message_seq"',
        'c."assigned_to_user_id" IS NULL',
        'c."awaiting_human_since" IS NULL',
        `t."outcome" <> 'discarded'`,
        `c."status" = 'open'`,
      ]) {
        expect(sql).toContain(condicion);
      }
      expect(params).toEqual([
        new Date(AHORA.getTime() - 60_000),
        new Date(AHORA.getTime() - 24 * 3_600_000),
        true,
      ]);
    });

    it('en horario sin fija que corresponda: el aviso de derivación', async () => {
      const t = perdido();
      expect(await t.rescatar()).toBe(1);
      expect(t.escritos).toEqual([
        expect.objectContaining({ templateKey: PLANTILLA_DE_DERIVACION }),
      ]);
    });

    it('idempotente: dos corridas no duplican, y el trabajo que llega tarde no publica encima', async () => {
      const t = perdido({ horario: CERRADA });
      expect(await t.rescatar()).toBe(1);
      expect(await t.rescatar()).toBe(0);
      // Aunque la consulta lo volviera a traer, la conversación ya espera a una persona.
      t.dataSource.query.mockImplementationOnce(() =>
        Promise.resolve([{ conversation_id: CONV, message_id: 'msg-5' }]),
      );
      expect(await t.rescatar()).toBe(0);
      await t.atender();
      expect(t.consultar).not.toHaveBeenCalled();
      expect(t.escritos).toHaveLength(1);
      expect(t.trazas).toHaveLength(1);
    });

    it.each<[string, Opciones]>([
      [
        'la IA sí lo atendió (traza publicada)',
        {
          trazas: [
            {
              conversationId: CONV,
              channel: 'staff_customer',
              distributorId: EMPRESA,
              triggerMessageId: 'msg-5',
              outcome: 'answered',
              reason: null,
              model: 'claude-haiku-5-5',
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              replyMessageId: 'resp-x',
            },
          ],
        },
      ],
      [
        'la IA contestó (su respuesta es el último mensaje)',
        {
          filas: [
            fila(5, Party.CUSTOMER, hace(3)),
            fila(6, Party.SYSTEM, hace(2), {
              kind: MessageKind.AUTO_REPLY,
              de_la_ia: true,
            }),
          ],
        },
      ],
      [
        'salió una fija (es el último mensaje)',
        {
          filas: [
            fila(5, Party.CUSTOMER, hace(3)),
            fila(6, Party.SYSTEM, hace(3), { kind: MessageKind.AUTO_REPLY }),
          ],
        },
      ],
      [
        'es de hace menos de 60 s',
        { filas: [fila(5, Party.CUSTOMER, hace(0.5))] },
      ],
      [
        'es de hace más de 24 h',
        { filas: [fila(5, Party.CUSTOMER, hace(25 * 60))] },
      ],
      ['la tomó alguien', { conversacion: { assignedToUserId: 'adm-1' } }],
      [
        'ya espera a una persona',
        { conversacion: { awaitingHumanSince: hace(1) } },
      ],
    ])('no toca: %s', async (_caso, o) => {
      const t = perdido(o);
      expect(await t.rescatar()).toBe(0);
      expect(t.escritos).toEqual([]);
    });

    it('no toca si la IA está apagada o si el trabajo todavía tiene la conversación (lock)', async () => {
      const apagada = perdido({ empresaPrendida: false });
      expect(await apagada.rescatar()).toBe(0);
      const ocupada = perdido({ lock: false });
      expect(await ocupada.rescatar()).toBe(0);
      expect(ocupada.escritos).toEqual([]);
      expect(ocupada.redis.withLock).toHaveBeenCalledWith(
        `asistente:${CONV}`,
        expect.any(Number),
        expect.any(Function),
      );
    });

    it('antes de rescatar, apaga el interruptor de las empresas que perdieron la función (venció la excepción)', async () => {
      const t = perdido({
        empresasPrendidas: [EMPRESA],
        moduloHabilitado: false,
      });
      expect(await t.rescatar()).toBe(0);
      expect(t.manager.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE "chat_company_settings"'),
        [EMPRESA],
      );
    });

    describe('una empresa no tapa a las demás', () => {
      interface Pendiente {
        conversation_id: string;
        message_id: string;
        distributor_id: string;
        channel: Channel;
        created_at: Date;
        /** Interruptor de la IA de la empresa (C3). */
        ia: boolean;
        /** Chat de clientes de la empresa (C3). */
        chatDeClientes: boolean;
      }
      /**
       * La base del rescate como la ve el SQL: el doble aplica cada condición
       * sólo si la consulta la tiene (filtro de la IA, del chat de clientes y
       * del soporte; partición; tope por turno; orden por turno), así el test
       * falla si se quita cualquiera. El SQL real se prueba contra Postgres
       * con `.orq/prueba-rescate/` (tablas temporales, ROLLBACK).
       */
      const candidatosSegun = (
        sql: string,
        params: unknown[],
        pendientes: Pendiente[],
      ) => {
        const c3 = (f: Pendiente) => f.channel === Channel.STAFF_CUSTOMER;
        let filas = [...pendientes].sort(
          (a, b) =>
            a.created_at.getTime() - b.created_at.getTime() ||
            a.message_id.localeCompare(b.message_id),
        );
        if (sql.includes('s."assistant_ai_enabled"')) {
          filas = filas.filter((f) => !c3(f) || f.ia);
        }
        if (sql.includes('s."customer_chat_enabled"')) {
          filas = filas.filter((f) => !c3(f) || f.chatDeClientes);
        }
        if (sql.includes('$3::boolean')) {
          filas = filas.filter((f) => c3(f) || params[2] === true);
        }
        const particion = /PARTITION BY (.+?) ORDER BY/.exec(sql)?.[1] ?? null;
        const clave = (f: Pendiente) =>
          [
            particion?.includes('c."distributor_id"') ? f.distributor_id : '',
            particion?.includes('c."channel"') ? f.channel : '',
          ].join('|');
        const turnos = new Map<string, number>();
        let conTurno = filas.map((f) => {
          const turno = (turnos.get(clave(f)) ?? 0) + 1;
          turnos.set(clave(f), turno);
          return { f, turno };
        });
        if (particion && sql.includes('"turno" <=')) {
          conTurno = conTurno.filter(
            ({ turno }) => turno <= TOPE_DEL_RESCATE_POR_EMPRESA,
          );
        }
        if (particion && sql.includes('ORDER BY "turno"')) {
          conTurno = [...conTurno].sort(
            (a, b) =>
              a.turno - b.turno ||
              a.f.created_at.getTime() - b.f.created_at.getTime(),
          );
        }
        return conTurno.slice(0, TOPE_DEL_RESCATE).map(({ f }) => ({
          conversation_id: f.conversation_id,
          message_id: f.message_id,
        }));
      };
      const pendientesDe = (
        empresa: string,
        cuantos: number,
        ia: boolean,
        desdeMin: number,
        channel = Channel.STAFF_CUSTOMER,
        chatDeClientes = true,
      ): Pendiente[] =>
        Array.from({ length: cuantos }, (_, i) => ({
          conversation_id: `${empresa}-${channel}-conv-${i}`,
          message_id: `${empresa}-${channel}-msg-${i}`,
          distributor_id: empresa,
          channel,
          created_at: hace(desdeMin - i * 0.01),
          ia,
          chatDeClientes,
        }));
      const B = 'dist-b-staff_customer-conv-0';
      const correr = async (
        pendientes: Pendiente[],
        soportePrendido = true,
      ) => {
        const t = armar({ soportePrendido });
        const original = t.dataSource.query.getMockImplementation();
        t.dataSource.query.mockImplementation(
          (sql: string, params: unknown[] = []) =>
            sql.includes('JOIN "message" m')
              ? Promise.resolve(candidatosSegun(sql, params, pendientes))
              : original!(sql, params),
        );
        const rescatados = jest
          .spyOn(
            t.servicio as unknown as {
              rescatar: (c: string, m: string, a: Date) => Promise<boolean>;
            },
            'rescatar',
          )
          .mockResolvedValue(true);
        await t.rescatar();
        return rescatados.mock.calls.map(([conv]) => conv);
      };

      it('A sin IA con 150 pendientes más viejos y B con IA con 1: B se rescata en la primera corrida', async () => {
        const tomados = await correr([
          ...pendientesDe('dist-a', 150, false, 600),
          ...pendientesDe('dist-b', 1, true, 2),
        ]);
        expect(tomados).toContain(B);
        expect(tomados.some((c) => c.startsWith('dist-a'))).toBe(false);
      });

      it('una empresa con la IA prendida pero el chat de clientes apagado tampoco ocupa la corrida', async () => {
        const tomados = await correr([
          ...pendientesDe(
            'dist-c',
            150,
            true,
            600,
            Channel.STAFF_CUSTOMER,
            false,
          ),
          ...pendientesDe('dist-b', 1, true, 2),
        ]);
        expect(tomados).toEqual([B]);
      });

      it('la corrida va por turnos: con 6 empresas de 30 pendientes más viejos, la de 1 entra en la primera vuelta', async () => {
        const tomados = await correr([
          ...['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].flatMap((d, i) =>
            pendientesDe(d, 30, true, 600 - i),
          ),
          ...pendientesDe('dist-b', 1, true, 2),
        ]);
        expect(tomados).toHaveLength(TOPE_DEL_RESCATE);
        expect(tomados).toContain(B);
      });

      it('el chat de una empresa con sus clientes no tapa su chat con el soporte (reparto por empresa y canal)', async () => {
        const tomados = await correr([
          ...pendientesDe('dist-f', 30, true, 600),
          ...pendientesDe('dist-f', 1, true, 2, Channel.PLATFORM_CHAT),
        ]);
        expect(tomados).toContain('dist-f-platform_chat-conv-0');
        expect(
          tomados.filter((c) => c.startsWith('dist-f-staff_customer')),
        ).toHaveLength(TOPE_DEL_RESCATE_POR_EMPRESA);
      });

      it('A con IA y 150 pendientes no acapara la corrida: B (1) entra y A queda con su tope por empresa', async () => {
        const tomados = await correr([
          ...pendientesDe('dist-a', 150, true, 600),
          ...pendientesDe('dist-b', 1, true, 2),
        ]);
        expect(tomados).toContain(B);
        expect(tomados.filter((c) => c.startsWith('dist-a'))).toHaveLength(
          TOPE_DEL_RESCATE_POR_EMPRESA,
        );
      });

      it('el soporte con la IA apagada no ocupa la corrida', async () => {
        const t = armar({ soportePrendido: false });
        await t.rescatar();
        const [sql, params] = t.dataSource.query.mock.calls.find(([q]) =>
          q.includes('JOIN "message" m'),
        ) as unknown as [string, unknown[]];
        expect(params[2]).toBe(false);
        expect(
          candidatosSegun(sql, params, [
            ...pendientesDe('dist-a', 150, true, 600, Channel.PLATFORM_CHAT),
            ...pendientesDe('dist-b', 1, true, 2),
          ]),
        ).toEqual([
          { conversation_id: B, message_id: 'dist-b-staff_customer-msg-0' },
        ]);
      });
    });

    it('una empresa que falla al revisar si sigue con la función no frena a las demás ni al rescate: queda en el monitoreo', async () => {
      const t = perdido({
        empresasPrendidas: ['dist-rota', 'dist-sin-funcion'],
        horario: CERRADA,
      });
      t.acceso.habilitado.mockImplementation((id: string) =>
        id === 'dist-rota'
          ? Promise.reject(new Error('acceso caído'))
          : Promise.resolve(id !== 'dist-sin-funcion'),
      );
      const corrida = nuevaCorrida();
      expect(await dentroDeCorrida(corrida, () => t.rescatar())).toBe(1);
      expect(t.manager.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE "chat_company_settings"'),
        ['dist-sin-funcion'],
      );
      expect(corrida).toMatchObject({
        errors: 1,
        fatal: null,
        lastError: 'acceso caído',
      });
      expect([...corrida.elementos.fallidos.keys()]).toEqual([
        'empresa:dist-rota',
      ]);
    });

    it('si una conversación falla, sigue con las demás y no tira (y queda en el monitoreo)', async () => {
      const t0 = perdido({ falloAlEscribir: new Error('se cayó la base') });
      const corrida = nuevaCorrida();
      await expect(dentroDeCorrida(corrida, () => t0.rescatar())).resolves.toBe(
        0,
      );
      expect([...corrida.elementos.fallidos.keys()]).toEqual(['mensaje:msg-5']);
    });

    it('si una conversación falla, sigue con las demás y no tira', async () => {
      const t = perdido({ falloAlEscribir: new Error('se cayó la base') });
      await expect(t.rescatar()).resolves.toBe(0);
    });
  });
});
