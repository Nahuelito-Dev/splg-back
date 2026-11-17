import type { DataSource, EntityManager } from 'typeorm';
import type { StaffPermissionsService } from '../../admin/staff-permissions.service';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
  SubjectType,
  SystemCode,
} from '../domain/chat.enums';
import { ChatCompanySettings } from '../entities/chat-company-settings.entity';
import { Conversation } from '../entities/conversation.entity';
import { MessageEdit } from '../entities/message-edit.entity';
import { Message } from '../entities/message.entity';
import { type ActorDeLaBandeja, BandejaAcceso } from './bandeja-acceso';
import type { AccesoDeLaEmpresa } from '../../platform/access/acceso-de-la-empresa.service';
import { AsistenteDelChat } from './asistente-del-chat';
import { BandejaService, recalcularVistaPrevia } from './bandeja.service';
import type { ChatViewsService } from './chat-views.service';
import { RespuestasFijas } from './respuestas-fijas';
import {
  configuracionPorDefecto,
  type SupportSettingsService,
} from './support-settings.service';
import type { ChatEvents, Efectos } from './chat.events';
import type { ChatRateLimit } from './chat-rate-limit';
import type { ChatThreadsService } from './chat-threads.service';
import { ConversacionCerradaError } from '../domain/chat.errors';
import {
  ajustesDeLaBandejaPorDefecto,
  type CompanyChatSettingsService,
} from './company-chat-settings.service';
import type { CompanyTemplatesService } from './company-templates.service';
import type { ConversationFactory } from './conversation-factory';
import type { ConversacionVigente } from './conversacion-vigente';
import type { MessageWriter } from './message-writer';
import type {
  OpenMyConversationDto,
  SendCustomerActionDto,
} from '../presentation/dto/bandeja-input.dto';

const D = 'dist-a';
const ahora = new Date('2026-11-16T15:00:00Z'); // lunes 12:00 en Buenos Aires
const hace = (min: number) => new Date(ahora.getTime() - min * 60_000);

const cliente: ActorDeLaBandeja = {
  party: Party.CUSTOMER,
  userId: 'cli-1',
  distributorId: D,
  canales: [Channel.STAFF_CUSTOMER],
  permisos: [],
};
const chofer: ActorDeLaBandeja = {
  party: Party.DRIVER,
  userId: 'cho-1',
  distributorId: D,
  canales: [Channel.STAFF_DRIVER],
  permisos: [],
};
const soloChoferes: ActorDeLaBandeja = {
  party: Party.COMPANY,
  userId: 'adm-2',
  distributorId: D,
  canales: [Channel.STAFF_DRIVER],
  permisos: ['mensajes.choferes'],
};
const personal: ActorDeLaBandeja = {
  party: Party.COMPANY,
  userId: 'adm-1',
  distributorId: D,
  canales: [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER],
  permisos: ['mensajes.clientes', 'mensajes.choferes', 'reclamos.gestionar'],
};

function conversacion(cambios: Partial<Conversation> = {}): Conversation {
  return Object.assign(new Conversation(), {
    conversationId: 'conv-1',
    distributorId: D,
    channel: Channel.STAFF_CUSTOMER,
    subjectType: SubjectType.GENERAL,
    status: ConversationStatus.OPEN,
    orderId: null,
    customerUserId: 'cli-1',
    driverUserId: null,
    linkedClaimId: null,
    assignedToUserId: null,
    lastMessageSeq: 4,
    createdAt: hace(60),
    updatedAt: hace(1),
    ...cambios,
  });
}

function mensaje(cambios: Partial<Message> = {}): Message {
  return Object.assign(new Message(), {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    distributorId: D,
    seq: 3,
    senderParty: Party.CUSTOMER,
    senderUserId: 'cli-1',
    kind: MessageKind.TEXT,
    visibility: MessageVisibility.ALL,
    body: 'Hola',
    createdAt: hace(5),
    redactedAt: null,
    deletedAt: null,
    editedAt: null,
    withdrawnAt: null,
    withdrawnByUserId: null,
    replyToSeq: null,
    ...cambios,
  });
}

/**
 * Lo mínimo de la base: el `manager` de la transacción con repositorios por
 * entidad y `query` que responde según la consulta. Lo que se escribe queda
 * anotado para mirarlo.
 */
function armar(opciones: {
  conversacion?: Conversation | null;
  mensaje?: Message | null;
  consultas?: (sql: string) => unknown[];
  ajustes?: Partial<ChatCompanySettings>;
  /** La conversación ya no se puede escribir (chofer cambiado, persona fuera de la empresa). */
  noEscribible?: Error;
  /** La que encuentra «la abierta del tema» al abrir. */
  abiertaDelTema?: Conversation | null;
  /** El asistente con IA prendido para la empresa (interruptor y función). */
  ia?: boolean;
}) {
  const escritos: Array<{ entidad: string; datos: unknown }> = [];
  const repos = new Map<unknown, Record<string, jest.Mock>>([
    [
      Message,
      {
        findOne: jest.fn().mockResolvedValue(opciones.mensaje ?? null),
        // `yaEscrito`: ningún mensaje previo con ese `clientMessageId`.
        createQueryBuilder: jest.fn(() => {
          const qb: Record<string, jest.Mock> = {};
          for (const f of ['innerJoin', 'where', 'andWhere']) {
            qb[f] = jest.fn(() => qb);
          }
          qb.getOne = jest.fn().mockResolvedValue(null);
          return qb;
        }),
        update: jest.fn((_w, datos: unknown) => {
          escritos.push({ entidad: 'Message', datos });
          return Promise.resolve();
        }),
      },
    ],
    [
      MessageEdit,
      {
        insert: jest.fn((datos: unknown) => {
          escritos.push({ entidad: 'MessageEdit', datos });
          return Promise.resolve();
        }),
      },
    ],
    [
      Conversation,
      {
        findOne: jest
          .fn()
          .mockResolvedValue(
            opciones.abiertaDelTema !== undefined
              ? opciones.abiertaDelTema
              : (opciones.conversacion ?? null),
          ),
        findOneByOrFail: jest.fn().mockResolvedValue(opciones.conversacion),
      },
    ],
  ]);
  const consultas: string[] = [];
  const parametros: unknown[][] = [];
  const manager = {
    getRepository: (e: unknown) => repos.get(e),
    query: jest.fn((sql: string, params: unknown[] = []) => {
      consultas.push(sql);
      parametros.push(params);
      return Promise.resolve(opciones.consultas?.(sql) ?? []);
    }),
  } as unknown as EntityManager;
  const dataSource = {
    manager,
    transaction: jest.fn((fn: (m: EntityManager) => Promise<unknown>) =>
      fn(manager),
    ),
  } as unknown as DataSource;
  const acceso = new BandejaAcceso(
    dataSource,
    {} as unknown as StaffPermissionsService,
  );
  const buscar = jest
    .spyOn(acceso, 'buscar')
    .mockImplementation(() =>
      opciones.conversacion
        ? Promise.resolve(opciones.conversacion)
        : Promise.reject(new Error('no debería buscar')),
    );
  const escribir = jest.fn((_m: EntityManager, nuevo: { seq?: number }) =>
    Promise.resolve({
      created: true,
      message: mensaje({ ...nuevo, seq: 9 } as Partial<Message>),
      conversation: opciones.conversacion ?? conversacion(),
    }),
  );
  const ajustes = {
    leer: jest
      .fn()
      .mockResolvedValue(
        Object.assign(ajustesDeLaBandejaPorDefecto(D), opciones.ajustes ?? {}),
      ),
  };
  const publicados: Efectos[] = [];
  const cupos = { mensaje: jest.fn() };
  const vigente = {
    assertSePuedeEscribir: jest.fn(() =>
      opciones.noEscribible
        ? Promise.reject(opciones.noEscribible)
        : Promise.resolve(),
    ),
  };
  const crear = jest.fn((_m: EntityManager, nueva: Partial<Conversation>) =>
    Promise.resolve(conversacion({ ...nueva, conversationId: 'conv-nueva' })),
  );
  const soporte = {
    leer: jest.fn(() => Promise.resolve(configuracionPorDefecto())),
  };
  const leerAjustes = ajustes.leer as () => Promise<ChatCompanySettings>;
  const ajustesConIa = {
    ...ajustes,
    leer: jest.fn(async () =>
      Object.assign(await leerAjustes(), {
        assistantAiEnabled: opciones.ia ?? false,
      }),
    ),
  };

  // Las reales, sobre los mismos dobles: la regla de «la IA se encarga» y las fijas.
  const asistente = new AsistenteDelChat(
    {
      habilitado: jest.fn(() => Promise.resolve(opciones.ia ?? false)),
    } as unknown as AccesoDeLaEmpresa,
    ajustesConIa as unknown as CompanyChatSettingsService,
    soporte as unknown as SupportSettingsService,
  );
  const fijas = new RespuestasFijas(
    { escribir } as unknown as MessageWriter,
    ajustesConIa as unknown as CompanyChatSettingsService,
    soporte as unknown as SupportSettingsService,
    {} as ChatViewsService,
  );
  const servicio = new BandejaService(
    dataSource,
    acceso,
    { escribir } as unknown as MessageWriter,
    { crear } as unknown as ConversationFactory,
    {} as unknown as ChatThreadsService,
    ajustes as unknown as CompanyChatSettingsService,
    {} as unknown as CompanyTemplatesService,
    cupos as unknown as ChatRateLimit,
    {
      publicar: (e: Efectos) => publicados.push(e),
    } as unknown as ChatEvents,
    vigente as unknown as ConversacionVigente,
    fijas,
    asistente,
  );
  return {
    servicio,
    escritos,
    escribir,
    consultas,
    publicados,
    buscar,
    cupos,
    vigente,
    crear,
    repos,
    parametros,
  };
}

const codigo = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'sin error';
  } catch (e) {
    const x = e as {
      code?: string;
      getStatus?: () => number;
      getResponse?: () => { code?: string };
    };
    return x.code ?? x.getResponse?.()?.code ?? String(x.getStatus?.());
  }
};

describe('BandejaService: abrir (§4.3, §4.4)', () => {
  it('cliente sin vínculo ni pedidos con la empresa → 404 (no se confirma que exista)', async () => {
    const { servicio, escribir } = armar({ consultas: () => [] });
    const r = servicio.abrirDeLaPersona(cliente, {
      subjectType: SubjectType.GENERAL,
      firstMessage: { clientMessageId: 'c', body: 'Hola' },
    });
    await expect(r).rejects.toMatchObject({
      message: 'No encontramos a la distribuidora',
    });
    expect(escribir).not.toHaveBeenCalled();
  });

  it('con el chat de clientes apagado el cliente no abre → 403 CUSTOMER_CHAT_DISABLED', async () => {
    const { servicio } = armar({ ajustes: { customerChatEnabled: false } });
    expect(
      await codigo(
        servicio.abrirDeLaPersona(cliente, {
          subjectType: SubjectType.GENERAL,
          firstMessage: { clientMessageId: 'c', body: 'Hola' },
        }),
      ),
    ).toBe('CUSTOMER_CHAT_DISABLED');
  });

  it('el personal sólo de choferes no abre con un cliente → 403', async () => {
    const { servicio } = armar({});
    expect(
      await codigo(
        servicio.abrirDelPersonal(soloChoferes, {
          channel: Channel.STAFF_CUSTOMER,
          subjectType: SubjectType.GENERAL,
          customerId: 'cli-1',
          firstMessage: { clientMessageId: 'c', body: 'Hola' },
        }),
      ),
    ).toBe('PERMISSION_DENIED');
  });

  it('el personal con un cliente que no es de la empresa (sólo de otra) → 404', async () => {
    const { servicio, escribir } = armar({ consultas: () => [] });
    await expect(
      servicio.abrirDelPersonal(personal, {
        channel: Channel.STAFF_CUSTOMER,
        subjectType: SubjectType.GENERAL,
        customerId: 'cli-de-b',
        firstMessage: { clientMessageId: 'c', body: 'Hola' },
      }),
    ).rejects.toMatchObject({ message: 'No existe ese cliente' });
    expect(escribir).not.toHaveBeenCalled();
  });

  it('general con pedido → 400', async () => {
    const { servicio } = armar({});
    expect(
      await codigo(
        servicio.abrirDeLaPersona(cliente, {
          subjectType: SubjectType.GENERAL,
          orderId: 'p-1',
          firstMessage: { clientMessageId: 'c', body: 'Hola' },
        }),
      ),
    ).toBe('400');
  });
});

describe('BandejaService: responder automáticamente al cliente (§8.4)', () => {
  // Atiende sólo los domingos: el lunes a las 12 está cerrado.
  const cerrada = {
    businessHours: [{ weekday: 0, opensAt: '09:00', closesAt: '18:00' }],
  };

  it('fuera de horario y sin respuesta en este período: una automática con el fin del período', async () => {
    const c = conversacion();
    const { servicio, escribir } = armar({
      conversacion: c,
      ajustes: cerrada,
      consultas: (sql) =>
        sql.includes('AS fuera')
          ? [{ fuera: false, recibido: false, empresa: false }]
          : [{ persona: 'Ana Pérez', empresa: 'Gas Norte' }],
    });
    await servicio.enviar(
      cliente,
      'conv-1',
      { clientMessageId: 'c', body: 'Hola' },
      ahora,
    );
    expect(escribir).toHaveBeenCalledTimes(2);
    const auto = escribir.mock.calls[1][1] as unknown as {
      kind: MessageKind;
      payload: { until: string };
      body: string;
      senderParty: Party;
    };
    expect(auto.kind).toBe(MessageKind.AUTO_REPLY);
    expect(auto.senderParty).toBe(Party.SYSTEM);
    expect(auto.payload.until).toBe('2026-11-22T12:00:00.000Z');
    expect(auto.body).toBe(
      'Ahora estamos fuera de horario. Te respondemos el domingo 22/11 a las 09:00.',
    );
  });

  it('si ya se respondió en este período cerrado, no se repite', async () => {
    const { servicio, escribir, consultas } = armar({
      conversacion: conversacion(),
      ajustes: cerrada,
      consultas: (sql) =>
        sql.includes('AS fuera')
          ? [{ fuera: true, recibido: false, empresa: false }]
          : [],
    });
    await servicio.enviar(
      cliente,
      'conv-1',
      { clientMessageId: 'c', body: 'Hola' },
      ahora,
    );
    expect(escribir).toHaveBeenCalledTimes(1);
    expect(consultas.find((q) => q.includes('AS fuera'))).toContain(
      `"payload" ->> 'until' = $2`,
    );
  });

  it('en horario con el aviso prendido: «recibido» como mensaje de sistema', async () => {
    const { servicio, escribir } = armar({
      conversacion: conversacion(),
      ajustes: { ackEnabled: true },
      consultas: (sql) =>
        sql.includes('AS fuera')
          ? [{ fuera: false, recibido: false, empresa: false }]
          : [{ persona: 'Ana', empresa: 'Gas Norte' }],
    });
    await servicio.enviar(
      cliente,
      'conv-1',
      { clientMessageId: 'c', body: 'Hola' },
      ahora,
    );
    const aviso = escribir.mock.calls[1][1] as unknown as {
      kind: MessageKind;
      systemCode: SystemCode;
      body: string;
    };
    expect(aviso.kind).toBe(MessageKind.SYSTEM);
    expect(aviso.systemCode).toBe(SystemCode.RECEIVED_ACK);
    expect(aviso.body).toContain('Gas Norte');
  });

  it('la respuesta automática guarda la firma del asistente con el nombre de marca (no se recalcula al leer)', async () => {
    const consultasDeLaEmpresa: string[] = [];
    const casos: Array<[Partial<ChatCompanySettings>, string]> = [
      [cerrada, 'Asistente de Florchi Gas'],
      [
        { ...cerrada, assistantName: 'Gasito de {{empresa.nombre}}' },
        'Gasito de Florchi Gas',
      ],
      [{ ackEnabled: true }, 'Asistente de Florchi Gas'],
    ];
    for (const [ajustes, firma] of casos) {
      const { servicio, escribir } = armar({
        conversacion: conversacion(),
        ajustes,
        consultas: (sql) => {
          if (sql.includes('AS fuera')) {
            return [{ fuera: false, recibido: false, empresa: false }];
          }
          // La de la asignación automática (8b): no es del nombre.
          if (sql.includes('FOR SHARE')) return [];
          consultasDeLaEmpresa.push(sql);
          return [{ persona: 'Ana Pérez', empresa: 'Florchi Gas' }];
        },
      });
      await servicio.enviar(
        cliente,
        'conv-1',
        { clientMessageId: 'c', body: 'Hola' },
        ahora,
      );
      const auto = escribir.mock.calls[1][1] as unknown as {
        payload: { senderLabel?: string; until?: string };
        body: string;
      };
      expect(auto.payload.senderLabel).toBe(firma);
    }
    // `{{empresa.nombre}}` sale del nombre de marca (si lo hay), no del legal.
    expect(
      consultasDeLaEmpresa.every((q) => q.includes('"distributor_theme"')),
    ).toBe(true);
  });

  describe('con el asistente con IA prendido (B3): la IA reemplaza a las fijas', () => {
    /** Una fila del hilo como la devuelve la consulta de `AsistenteDelChat`. */
    const fila = (
      seq: number,
      sender_party: Party,
      creado: Date,
      extra: Record<string, unknown> = {},
    ) => ({
      seq: String(seq),
      message_id: `m-${seq}`,
      sender_party,
      kind: 'text',
      de_la_ia: false,
      created_at: creado.toISOString(),
      retirado: false,
      ...extra,
    });
    /** El hilo real: el mensaje del cliente que se acaba de escribir (seq 9) y lo que haya antes. */
    const conHilo =
      (previas: Array<ReturnType<typeof fila>>) => (sql: string) => {
        if (sql.includes('"de_la_ia"')) {
          return [
            ...previas,
            fila(9, Party.CUSTOMER, ahora, { message_id: 'msg-1' }),
          ];
        }
        if (sql.includes('AS fuera')) {
          return [{ fuera: false, recibido: false, empresa: false }];
        }
        return [{ persona: 'Ana', empresa: 'Gas Norte' }];
      };
    const enviar = (servicio: BandejaService) =>
      servicio.enviar(
        cliente,
        'conv-1',
        { clientMessageId: 'c', body: 'Hola' },
        ahora,
      );

    it('fuera de horario y en horario con aviso: no sale ninguna fija (la contesta la IA después)', async () => {
      for (const ajustes of [cerrada, { ackEnabled: true }]) {
        const { servicio, escribir } = armar({
          conversacion: conversacion(),
          ajustes,
          ia: true,
          consultas: conHilo([fila(2, Party.CUSTOMER, hace(300))]),
        });
        await enviar(servicio);
        expect(escribir).toHaveBeenCalledTimes(1);
      }
    });

    it('salen las fijas como siempre si la IA no se encarga: apagada, asignada, esperando persona o alguien del equipo escribió hace menos de 2 h', async () => {
      const casos: Array<Parameters<typeof armar>[0]> = [
        { conversacion: conversacion(), consultas: conHilo([]), ia: false },
        {
          conversacion: conversacion({ assignedToUserId: 'adm-1' }),
          consultas: conHilo([]),
          ia: true,
        },
        {
          conversacion: conversacion({ awaitingHumanSince: hace(10) }),
          consultas: conHilo([]),
          ia: true,
        },
        {
          conversacion: conversacion(),
          consultas: conHilo([fila(7, Party.COMPANY, hace(119))]),
          ia: true,
        },
      ];
      for (const caso of casos) {
        const { servicio, escribir } = armar({ ...caso, ajustes: cerrada });
        await enviar(servicio);
        expect(escribir).toHaveBeenCalledTimes(2);
        expect(
          (escribir.mock.calls[1][1] as unknown as { kind: MessageKind }).kind,
        ).toBe(MessageKind.AUTO_REPLY);
      }
    });

    it('si el equipo escribió hace más de 2 h, la IA vuelve a encargarse', async () => {
      const { servicio, escribir } = armar({
        conversacion: conversacion(),
        ajustes: cerrada,
        ia: true,
        consultas: conHilo([fila(7, Party.COMPANY, hace(121))]),
      });
      await enviar(servicio);
      expect(escribir).toHaveBeenCalledTimes(1);
    });
  });

  it('alguien del equipo escribe: la conversación deja de esperar a una persona', async () => {
    const c = conversacion({ awaitingHumanSince: hace(30) });
    const { servicio, consultas, parametros } = armar({ conversacion: c });
    await servicio.enviar(
      personal,
      'conv-1',
      { clientMessageId: 'c', body: 'Hola, te atiendo yo' },
      ahora,
    );
    const i = consultas.findIndex((q) =>
      q.includes('SET "awaiting_human_since" = NULL'),
    );
    expect(i).toBeGreaterThanOrEqual(0);
    expect(parametros[i]).toEqual(['conv-1']);
    // Sin espera, no escribe de más.
    const sin = armar({ conversacion: conversacion() });
    await sin.servicio.enviar(
      personal,
      'conv-1',
      { clientMessageId: 'c', body: 'Hola' },
      ahora,
    );
    expect(
      sin.consultas.some((q) => q.includes('"awaiting_human_since" = NULL')),
    ).toBe(false);
  });

  it('al chofer no le responde el sistema (C2 no tiene automáticas)', async () => {
    const { servicio, escribir } = armar({
      conversacion: conversacion({
        channel: Channel.STAFF_DRIVER,
        customerUserId: null,
        driverUserId: 'cho-1',
      }),
      ajustes: cerrada,
    });
    await servicio.enviar(
      chofer,
      'conv-1',
      { clientMessageId: 'c', body: 'Hola' },
      ahora,
    );
    expect(escribir).toHaveBeenCalledTimes(1);
  });

  it('el personal registra la primera respuesta si el cliente ya escribió', async () => {
    const { servicio, consultas } = armar({ conversacion: conversacion() });
    await servicio.enviar(
      personal,
      'conv-1',
      { clientMessageId: 'c', body: 'Hola' },
      ahora,
    );
    expect(consultas.join('\n')).toMatch(
      /SET "first_response_at" = now\(\)[\s\S]*"sender_party" IN \('customer', 'driver'\)/,
    );
  });
});

describe('BandejaService: editar un mensaje propio (D-C22)', () => {
  it('del autor, en los 15 minutos: guarda el texto anterior y avisa en vivo', async () => {
    const c = conversacion({ lastMessageSeq: 3 });
    const { servicio, escritos, publicados } = armar({
      conversacion: c,
      mensaje: mensaje(),
    });
    const m = await servicio.editar(cliente, 'conv-1', 'msg-1', 'Hola!', ahora);
    expect(m.body).toBe('Hola!');
    expect(m.editedAt).toEqual(ahora);
    expect(escritos).toEqual([
      {
        entidad: 'MessageEdit',
        datos: expect.objectContaining({
          messageId: 'msg-1',
          previousBody: 'Hola',
          editedByUserId: 'cli-1',
        }) as unknown,
      },
      { entidad: 'Message', datos: { body: 'Hola!', editedAt: ahora } },
    ]);
    expect(publicados[0].ediciones).toHaveLength(1);
  });

  it('de otra persona (también un compañero) → 403 MESSAGE_NOT_OWN', async () => {
    const { servicio } = armar({
      conversacion: conversacion(),
      mensaje: mensaje({ senderUserId: 'adm-9', senderParty: Party.COMPANY }),
    });
    expect(
      await codigo(servicio.editar(personal, 'conv-1', 'msg-1', 'x', ahora)),
    ).toBe('MESSAGE_NOT_OWN');
  });

  it('pasados los 15 minutos → 409; en una cerrada → 409; inexistente → 404', async () => {
    const viejo = armar({
      conversacion: conversacion(),
      mensaje: mensaje({ createdAt: hace(20) }),
    });
    expect(
      await codigo(
        viejo.servicio.editar(cliente, 'conv-1', 'msg-1', 'x', ahora),
      ),
    ).toBe('MESSAGE_EDIT_WINDOW_CLOSED');
    const cerrada = armar({
      conversacion: conversacion({ status: ConversationStatus.CLOSED }),
      mensaje: mensaje(),
    });
    expect(
      await codigo(
        cerrada.servicio.editar(cliente, 'conv-1', 'msg-1', 'x', ahora),
      ),
    ).toBe('CONVERSATION_CLOSED');
    const nada = armar({ conversacion: conversacion(), mensaje: null });
    expect(
      await codigo(
        nada.servicio.editar(cliente, 'conv-1', 'msg-1', 'x', ahora),
      ),
    ).toBe('404');
  });

  it('el mismo texto no escribe nada', async () => {
    const { servicio, escritos } = armar({
      conversacion: conversacion(),
      mensaje: mensaje(),
    });
    await servicio.editar(cliente, 'conv-1', 'msg-1', 'Hola', ahora);
    expect(escritos).toEqual([]);
  });
});

describe('BandejaService: borrar un mensaje propio (D-C23)', () => {
  const sinAtar = () => [{ reclamo: false, citado: false }];

  it('el cliente borra su texto: queda retirado (lógico) y avisa a las dos puntas', async () => {
    const c = conversacion({ lastMessageSeq: 3 });
    const { servicio, escritos, publicados } = armar({
      conversacion: c,
      mensaje: mensaje(),
      consultas: (sql) => (sql.includes('AS reclamo') ? sinAtar() : []),
    });
    const m = await servicio.borrar(cliente, 'conv-1', 'msg-1', ahora);
    expect(m.withdrawnAt).toEqual(ahora);
    expect(escritos).toEqual([
      {
        entidad: 'Message',
        datos: { withdrawnAt: ahora, withdrawnByUserId: 'cli-1' },
      },
    ]);
    expect(publicados[0].borrados).toHaveLength(1);
  });

  it('la vista previa de la bandeja pasa al último texto visible: el borrado no queda ni se encuentra con `q`', async () => {
    const { servicio, consultas, parametros } = armar({
      conversacion: conversacion({ lastMessageSeq: 3 }),
      mensaje: mensaje(),
      consultas: (sql) =>
        sql.includes('AS reclamo')
          ? sinAtar()
          : sql.includes('ORDER BY "seq" DESC LIMIT 1')
            ? [{ body: 'Lo que dijo la empresa antes', visibility: 'all' }]
            : [],
    });
    await servicio.borrar(cliente, 'conv-1', 'msg-1', ahora);
    const i = consultas.findIndex((q) =>
      q.includes('SET "last_message_preview" = $2'),
    );
    expect(parametros[i]).toEqual(['conv-1', 'Lo que dijo la empresa antes']);
  });

  it('el chofer no borra → 403 MESSAGE_DELETE_NOT_ALLOWED; el personal tampoco', async () => {
    const { servicio, buscar } = armar({ conversacion: conversacion() });
    expect(await codigo(servicio.borrar(chofer, 'conv-1', 'msg-1'))).toBe(
      'MESSAGE_DELETE_NOT_ALLOWED',
    );
    expect(await codigo(servicio.borrar(personal, 'conv-1', 'msg-1'))).toBe(
      'MESSAGE_DELETE_NOT_ALLOWED',
    );
    expect(buscar).not.toHaveBeenCalled();
  });

  it('uno de la empresa → 403 MESSAGE_NOT_OWN', async () => {
    const { servicio } = armar({
      conversacion: conversacion(),
      mensaje: mensaje({ senderParty: Party.COMPANY, senderUserId: 'adm-1' }),
    });
    expect(
      await codigo(servicio.borrar(cliente, 'conv-1', 'msg-1', ahora)),
    ).toBe('MESSAGE_NOT_OWN');
  });

  it('borrar otra vez devuelve lo mismo, sin escribir', async () => {
    const { servicio, escritos, publicados } = armar({
      conversacion: conversacion({ status: ConversationStatus.CLOSED }),
      mensaje: mensaje({ withdrawnAt: hace(1), withdrawnByUserId: 'cli-1' }),
    });
    const m = await servicio.borrar(cliente, 'conv-1', 'msg-1', ahora);
    expect(m.withdrawnAt).toEqual(hace(1));
    expect(escritos).toEqual([]);
    expect(publicados[0].borrados).toHaveLength(0);
  });

  it('cada regla con su 409', async () => {
    const caso = async (
      c: Partial<Conversation>,
      m: Partial<Message>,
      atado = { reclamo: false, citado: false },
    ) => {
      const { servicio } = armar({
        conversacion: conversacion(c),
        mensaje: mensaje(m),
        consultas: (sql) => (sql.includes('AS reclamo') ? [atado] : []),
      });
      return codigo(servicio.borrar(cliente, 'conv-1', 'msg-1', ahora));
    };
    expect(await caso({}, { createdAt: hace(16) })).toBe(
      'MESSAGE_DELETE_WINDOW_CLOSED',
    );
    expect(
      await caso({ subjectType: SubjectType.ORDER, orderId: 'p' }, {}),
    ).toBe('MESSAGE_IN_ORDER_CONVERSATION');
    expect(await caso({}, {}, { reclamo: true, citado: false })).toBe(
      'MESSAGE_LINKED_TO_CLAIM',
    );
    expect(await caso({}, {}, { reclamo: false, citado: true })).toBe(
      'MESSAGE_ALREADY_QUOTED',
    );
    expect(await caso({ status: ConversationStatus.CLOSED }, {})).toBe(
      'CONVERSATION_CLOSED',
    );
  });

  // Cuál mensaje queda atado lo decide la base (la consulta de abajo); el
  // comportamiento contra Postgres lo cubre el vivo («borrar el mensaje que
  // dio pie al reclamo → 409», «ya citado → 409»).
  it('la consulta de ataduras mira el reclamo vinculado, las citas de tickets y las respuestas', async () => {
    const { servicio, consultas } = armar({
      conversacion: conversacion({ linkedClaimId: 'cl-1' }),
      mensaje: mensaje(),
      consultas: (sql) => (sql.includes('AS reclamo') ? sinAtar() : []),
    });
    await servicio.borrar(cliente, 'conv-1', 'msg-1', ahora);
    const q = consultas.find((s) => s.includes('AS reclamo')) ?? '';
    expect(q).toContain(`cl."createdAt" >= $4`);
    expect(q).toContain('support_ticket_message_link');
    expect(q).toContain(`"reply_to_seq" = $5`);
  });
});

describe('Corrección 1: C2 por pedido del chofer, cupo, chat de clientes apagado', () => {
  it('abrir C2 por pedido busca la abierta del pedido Y del chofer', async () => {
    const { servicio, repos, crear } = armar({
      abiertaDelTema: null,
      consultas: (sql) =>
        sql.includes('FROM "order" o')
          ? [
              {
                order_id: 'p-1',
                status: 'accepted',
                customer_id: 'cli-9',
                driver_user_id: 'cho-2',
                terminado_en: null,
              },
            ]
          : [],
    });
    await servicio.abrirDelPersonal(personal, {
      channel: Channel.STAFF_DRIVER,
      subjectType: SubjectType.ORDER,
      orderId: 'p-1',
      firstMessage: { clientMessageId: 'c', body: 'Hola' },
    });
    const buscada = (
      repos.get(Conversation)?.findOne.mock.calls[0] as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    expect(buscada).toMatchObject({ orderId: 'p-1', driverUserId: 'cho-2' });
    expect(crear).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderId: 'p-1', driverUserId: 'cho-2' }),
    );
  });

  it('escribir en una que ya no es escribible (chofer cambiado) → 409 y no escribe', async () => {
    const { servicio, escribir } = armar({
      conversacion: conversacion(),
      noEscribible: new ConversacionCerradaError(),
    });
    expect(
      await codigo(
        servicio.enviar(personal, 'conv-1', {
          clientMessageId: 'c',
          body: 'x',
        }),
      ),
    ).toBe('CONVERSATION_CLOSED');
    expect(escribir).not.toHaveBeenCalled();
  });

  it('el cupo del cliente es el de la conversación real, también al abrir', async () => {
    const { servicio, cupos } = armar({
      conversacion: conversacion(),
      abiertaDelTema: null,
      consultas: (sql) => (sql.includes('FROM "user" u') ? [{}] : []),
    });
    await servicio.abrirDeLaPersona(cliente, {
      subjectType: SubjectType.GENERAL,
      firstMessage: { clientMessageId: 'c', body: 'Hola' },
    });
    expect(cupos.mensaje).toHaveBeenCalledWith({
      ambito: D,
      userId: 'cli-1',
      clientMessageId: 'c',
      conversacion: 'conv-nueva',
    });
    await servicio.enviar(cliente, 'conv-1', {
      clientMessageId: 'd',
      body: 'x',
    });
    expect(cupos.mensaje).toHaveBeenLastCalledWith({
      ambito: D,
      userId: 'cli-1',
      clientMessageId: 'd',
      conversacion: 'conv-1',
    });
  });

  it('la marca de reintento lleva la empresa: el mismo cliente y el mismo id en otra distribuidora piden cupo aparte', async () => {
    const { servicio, cupos } = armar({ conversacion: conversacion() });
    const dto = { clientMessageId: 'mismo', body: 'x' };
    await servicio.enviar(cliente, 'conv-1', dto);
    await servicio.enviar(
      { ...cliente, distributorId: 'dist-otra' },
      'conv-1',
      dto,
    );
    expect(
      cupos.mensaje.mock.calls.map(([p]) => (p as { ambito: string }).ambito),
    ).toEqual([D, 'dist-otra']);
  });

  it('el personal también pide cupo con su empresa (al abrir y al escribir)', async () => {
    const { servicio, cupos } = armar({ conversacion: conversacion() });
    await servicio.enviar(personal, 'conv-1', {
      clientMessageId: 'e',
      body: 'x',
    });
    expect(cupos.mensaje).toHaveBeenLastCalledWith({
      ambito: D,
      userId: 'adm-1',
      clientMessageId: 'e',
      conversacion: undefined,
    });
  });

  it('con el chat de clientes apagado el cliente tampoco edita ni borra → 403', async () => {
    const { servicio, escritos } = armar({
      conversacion: conversacion(),
      mensaje: mensaje(),
      ajustes: { customerChatEnabled: false },
    });
    expect(
      await codigo(servicio.editar(cliente, 'conv-1', 'msg-1', 'x', ahora)),
    ).toBe('CUSTOMER_CHAT_DISABLED');
    expect(
      await codigo(servicio.borrar(cliente, 'conv-1', 'msg-1', ahora)),
    ).toBe('CUSTOMER_CHAT_DISABLED');
    expect(escritos).toEqual([]);
  });

  it('editar tiene las mismas excepciones que borrar', async () => {
    const caso = async (
      c: Partial<Conversation>,
      atado = { reclamo: false, citado: false },
    ) => {
      const { servicio } = armar({
        conversacion: conversacion(c),
        mensaje: mensaje(),
        consultas: (sql) => (sql.includes('AS reclamo') ? [atado] : []),
      });
      return codigo(servicio.editar(cliente, 'conv-1', 'msg-1', 'x', ahora));
    };
    expect(await caso({ subjectType: SubjectType.ORDER, orderId: 'p' })).toBe(
      'MESSAGE_IN_ORDER_CONVERSATION',
    );
    expect(await caso({}, { reclamo: true, citado: false })).toBe(
      'MESSAGE_LINKED_TO_CLAIM',
    );
    expect(await caso({}, { reclamo: false, citado: true })).toBe(
      'MESSAGE_ALREADY_QUOTED',
    );
  });
});

describe('BandejaService: leer marca las menciones vistas (4a)', () => {
  function armarLectura() {
    const query = jest.fn(() => Promise.resolve([[], 0]));
    const dataSource = { query } as unknown as DataSource;
    const c = conversacion();
    const acceso = { buscar: jest.fn(() => Promise.resolve(c)) };
    const hilos = { leer: jest.fn(() => Promise.resolve()) };
    const servicio = new BandejaService(
      dataSource,
      acceso as unknown as BandejaAcceso,
      {} as MessageWriter,
      {} as ConversationFactory,
      hilos as unknown as ChatThreadsService,
      {} as CompanyChatSettingsService,
      {} as CompanyTemplatesService,
      {} as ChatRateLimit,
      {} as ChatEvents,
      {} as ConversacionVigente,
      {} as RespuestasFijas,
      {} as AsistenteDelChat,
    );
    return { servicio, query, hilos, c };
  }

  it('el personal que lee hasta un mensaje deja leídas sus menciones hasta ahí, en su empresa', async () => {
    const t = armarLectura();
    const yo: ActorDeLaBandeja = {
      party: Party.COMPANY,
      userId: 'adm-2',
      distributorId: D,
      canales: [Channel.STAFF_CUSTOMER],
      permisos: ['mensajes.clientes'],
    };
    await t.servicio.leer(yo, t.c.conversationId, 7);
    expect(t.hilos.leer).toHaveBeenCalledWith(
      t.c,
      { party: Party.COMPANY, userId: 'adm-2' },
      7,
    );
    const [sql, params] = t.query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain('UPDATE "message_mention"');
    expect(params).toEqual([t.c.conversationId, 'adm-2', D, 7]);
  });

  it('el cliente que lee no toca menciones', async () => {
    const t = armarLectura();
    await t.servicio.leer(
      {
        party: Party.CUSTOMER,
        userId: 'cli-1',
        distributorId: D,
        canales: [Channel.STAFF_CUSTOMER],
        permisos: [],
      },
      t.c.conversationId,
      7,
    );
    expect(t.hilos.leer).toHaveBeenCalled();
    expect(t.query).not.toHaveBeenCalled();
  });
});

describe('recalcularVistaPrevia (4a)', () => {
  it('sale del último mensaje visible: editar una nota no deja la vista previa vacía ni muestra la nota', async () => {
    const consultas: Array<[string, unknown[]]> = [];
    const manager = {
      query: jest.fn((sql: string, params: unknown[]) => {
        consultas.push([sql, params]);
        return Promise.resolve(
          sql.startsWith('SELECT')
            ? [{ body: 'Hola Ana', visibility: MessageVisibility.ALL }]
            : [],
        );
      }),
    } as unknown as EntityManager;
    await recalcularVistaPrevia(manager, 'conv-1');
    expect(consultas[0][0]).toContain(`"visibility" = 'all'`);
    expect(consultas[1][1]).toEqual(['conv-1', 'Hola Ana']);
  });
  it('si el último visible es un adjunto sin epígrafe, la vista previa es «📎 Foto», no el texto anterior (CH7)', async () => {
    const consultas: Array<[string, unknown[]]> = [];
    const manager = {
      query: jest.fn((sql: string, params: unknown[]) => {
        consultas.push([sql, params]);
        return Promise.resolve(
          sql.startsWith('SELECT')
            ? [
                {
                  kind: MessageKind.ATTACHMENT,
                  body: null,
                  visibility: MessageVisibility.ALL,
                  payload: { media: 'photo' },
                },
              ]
            : [],
        );
      }),
    } as unknown as EntityManager;
    await recalcularVistaPrevia(manager, 'conv-1');
    expect(consultas[0][0]).toContain(`"kind" = 'attachment'`);
    expect(consultas[1][1]).toEqual(['conv-1', '📎 Foto']);
  });
});

describe('BandejaService: botones de acción del cliente (4e)', () => {
  const tocar = (
    servicio: BandejaService,
    key: SendCustomerActionDto['key'],
    actor: ActorDeLaBandeja = cliente,
  ) =>
    servicio.accion(
      actor,
      'conv-1',
      { clientMessageId: '0d6f0c34-8b7e-4c1a-9f3b-5a2e7d9c1b20', key },
      ahora,
    );
  const sinFijas = (sql: string) =>
    sql.includes('AS fuera')
      ? [{ fuera: false, recibido: false, empresa: false }]
      : [{ persona: 'Ana', empresa: 'Gas Norte' }];

  it('`message`: manda el texto predefinido como mensaje del cliente, con su clientMessageId; no pide persona', async () => {
    const t = armar({ conversacion: conversacion(), consultas: sinFijas });
    const r = await tocar(t.servicio, 'where_is_my_order');
    expect(r.created).toBe(true);
    expect(t.escribir.mock.calls[0][1]).toMatchObject({
      senderParty: Party.CUSTOMER,
      senderUserId: 'cli-1',
      clientMessageId: '0d6f0c34-8b7e-4c1a-9f3b-5a2e7d9c1b20',
      body: '¿Dónde está mi pedido?',
    });
    expect(
      t.consultas.some((q) => q.includes('SET "awaiting_human_since" = $2')),
    ).toBe(false);
  });

  it('`talk_to_person`: manda el mensaje y la deja esperando persona dentro del envío; el asistente con IA no la toma y salen las fijas', async () => {
    const t = armar({
      conversacion: conversacion(),
      ajustes: { ackEnabled: true },
      ia: true,
      consultas: sinFijas,
    });
    await tocar(t.servicio, 'talk_to_person');
    expect(t.escribir.mock.calls[0][1]).toMatchObject({
      body: 'Quiero hablar con una persona.',
    });
    const i = t.consultas.findIndex((q) =>
      q.includes('SET "awaiting_human_since" = $2'),
    );
    expect(i).toBeGreaterThanOrEqual(0);
    // Pedir una persona es una derivación: motivo `handoff` (8b).
    expect(t.parametros[i]).toEqual(['conv-1', ahora, 'handoff']);
    expect(t.consultas[i]).toContain('"assigned_to_user_id" IS NULL');
    // Con la IA prendida, igual sale el aviso de recibido: ya espera a una persona.
    expect(t.escribir).toHaveBeenCalledTimes(2);
    expect(t.escribir.mock.calls[1][1]).toMatchObject({
      systemCode: SystemCode.RECEIVED_ACK,
    });
    expect(t.publicados[0].conversaciones).toEqual([
      expect.objectContaining({ change: 'status' }),
    ]);
  });

  it('`talk_to_person` en una ya asignada: no la pone a esperar', async () => {
    const t = armar({
      conversacion: conversacion({ assignedToUserId: 'adm-1' }),
      consultas: sinFijas,
    });
    await tocar(t.servicio, 'talk_to_person');
    expect(
      t.consultas.some((q) => q.includes('SET "awaiting_human_since" = $2')),
    ).toBe(false);
  });

  it.each<
    [string, Partial<ChatCompanySettings>, SendCustomerActionDto['key'], string]
  >([
    ['la de la app → 400', {}, 'repeat_last_order', 'ACTION_IS_APP_ONLY'],
    [
      'una que la empresa no muestra → 400',
      { customerActions: ['where_is_my_order'] },
      'payment_methods',
      'ACTION_NOT_AVAILABLE',
    ],
    [
      'con el chat de clientes apagado → 403',
      { customerChatEnabled: false },
      'where_is_my_order',
      'CUSTOMER_CHAT_DISABLED',
    ],
  ])('%s, sin escribir nada', async (_caso, ajustes, key, code) => {
    const t = armar({ conversacion: conversacion(), ajustes });
    expect(await codigo(tocar(t.servicio, key))).toBe(code);
    expect(t.escribir).not.toHaveBeenCalled();
  });

  it('el chofer → 403 CUSTOMER_ONLY', async () => {
    const t = armar({ conversacion: conversacion() });
    expect(await codigo(tocar(t.servicio, 'where_is_my_order', chofer))).toBe(
      'CUSTOMER_ONLY',
    );
  });

  it('la lista para un chat nuevo: las de la empresa, en orden; con el chat apagado, ninguna; el chofer, 403', async () => {
    const t = armar({
      ajustes: { customerActions: ['talk_to_person', 'payment_methods'] },
    });
    expect((await t.servicio.acciones(cliente)).map((a) => a.key)).toEqual([
      'payment_methods',
      'talk_to_person',
    ]);
    const apagado = armar({ ajustes: { customerChatEnabled: false } });
    expect(await apagado.servicio.acciones(cliente)).toEqual([]);
    expect(await codigo(t.servicio.acciones(chofer))).toBe('CUSTOMER_ONLY');
  });
});

describe('BandejaService: abrir el chat tocando un botón (4e)', () => {
  const consultas = (sql: string) => {
    if (sql.includes('"customer_distributor"')) return [{ uno: 1 }];
    if (sql.includes('AS fuera')) {
      return [{ fuera: false, recibido: false, empresa: false }];
    }
    return [{ persona: 'Ana', empresa: 'Gas Norte' }];
  };
  const abrirCon = (
    servicio: BandejaService,
    key: SendCustomerActionDto['key'],
    actor: ActorDeLaBandeja = cliente,
  ) =>
    servicio.abrirDeLaPersona(
      actor,
      {
        subjectType: SubjectType.GENERAL,
        firstAction: { clientMessageId: 'cm-a', key },
      },
      ahora,
    );

  it('`talk_to_person`: el primer mensaje es el texto del botón y la conversación queda esperando persona; con la IA prendida igual salen las fijas', async () => {
    const t = armar({
      conversacion: conversacion(),
      ajustes: { ackEnabled: true },
      ia: true,
      consultas,
    });
    await abrirCon(t.servicio, 'talk_to_person');
    expect(t.escribir.mock.calls[0][1]).toMatchObject({
      senderParty: Party.CUSTOMER,
      clientMessageId: 'cm-a',
      body: 'Quiero hablar con una persona.',
    });
    expect(
      t.consultas.some((q) => q.includes('SET "awaiting_human_since" = $2')),
    ).toBe(true);
    expect(t.escribir.mock.calls[1][1]).toMatchObject({
      systemCode: SystemCode.RECEIVED_ACK,
    });
  });

  it('`where_is_my_order`: manda el texto y no pide persona', async () => {
    const t = armar({ conversacion: conversacion(), consultas });
    await abrirCon(t.servicio, 'where_is_my_order');
    expect(t.escribir.mock.calls[0][1]).toMatchObject({
      body: '¿Dónde está mi pedido?',
    });
    expect(
      t.consultas.some((q) => q.includes('SET "awaiting_human_since" = $2')),
    ).toBe(false);
  });

  it.each<
    [string, Partial<ChatCompanySettings>, SendCustomerActionDto['key'], string]
  >([
    ['la de la app → 400', {}, 'repeat_last_order', 'ACTION_IS_APP_ONLY'],
    [
      'una que la empresa no muestra → 400',
      { customerActions: ['where_is_my_order'] },
      'talk_to_person',
      'ACTION_NOT_AVAILABLE',
    ],
    [
      'con el chat apagado → 403',
      { customerChatEnabled: false },
      'where_is_my_order',
      'CUSTOMER_CHAT_DISABLED',
    ],
  ])('%s, sin crear ni escribir nada', async (_caso, ajustes, key, code) => {
    const t = armar({ conversacion: conversacion(), ajustes, consultas });
    expect(await codigo(abrirCon(t.servicio, key))).toBe(code);
    expect(t.crear).not.toHaveBeenCalled();
    expect(t.escribir).not.toHaveBeenCalled();
  });

  it('el chofer no abre con un botón → 403 CUSTOMER_ONLY', async () => {
    const t = armar({ consultas });
    expect(
      await codigo(abrirCon(t.servicio, 'where_is_my_order', chofer)),
    ).toBe('CUSTOMER_ONLY');
  });

  it('ni mensaje ni botón, o los dos → 400', async () => {
    const t = armar({ consultas });
    for (const dto of [
      { subjectType: SubjectType.GENERAL } as OpenMyConversationDto,
      {
        subjectType: SubjectType.GENERAL,
        firstMessage: { clientMessageId: 'c', body: 'Hola' },
        firstAction: {
          clientMessageId: 'cm-a',
          key: 'where_is_my_order' as const,
        },
      } as OpenMyConversationDto,
    ]) {
      expect(await codigo(t.servicio.abrirDeLaPersona(cliente, dto))).toBe(
        '400',
      );
    }
  });
});

describe('BandejaService: con la asignación automática, escribir deja esperando a una persona (8b)', () => {
  const ESPERA = 'SET "awaiting_human_since" = $2';
  /** Los ajustes de la empresa, leídos con `FOR SHARE` en la transacción del mensaje. */
  const prendida = (sql: string) =>
    sql.includes('FOR SHARE') ? [{ auto_assign_enabled: true }] : [];
  const delChofer = () =>
    conversacion({
      channel: Channel.STAFF_DRIVER,
      customerUserId: null,
      driverUserId: 'cho-1',
    });
  const esperoDesde = (m: ReturnType<typeof armar>) => {
    const i = m.consultas.findIndex((q) => q.includes(ESPERA));
    return i === -1 ? null : m.parametros[i];
  };

  it('el cliente escribe, no hay asistente y nadie la tiene: espera desde ahora y avisa el cambio', async () => {
    const c = conversacion();
    const m = armar({ conversacion: c, consultas: prendida });
    await m.servicio.enviar(
      cliente,
      'conv-1',
      { clientMessageId: 'c', body: 'Hola' },
      ahora,
    );
    // Con motivo `auto_assign`: se limpia si se apaga la función.
    expect(esperoDesde(m)).toEqual(['conv-1', ahora, 'auto_assign']);
    expect(c.awaitingHumanSince).toEqual(ahora);
    expect(c.awaitingHumanReason).toBe('auto_assign');
    expect(m.publicados[0].conversaciones.map((x) => x.change)).toContain(
      'status',
    );
  });

  it('el chofer escribe (C2 no tiene asistente): también', async () => {
    const m = armar({
      conversacion: delChofer(),
      consultas: prendida,
    });
    await m.servicio.enviar(
      chofer,
      'conv-1',
      { clientMessageId: 'c', body: 'Llegué' },
      ahora,
    );
    expect(esperoDesde(m)).toEqual(['conv-1', ahora, 'auto_assign']);
  });

  it('con la función apagada nada cambia (ni el cliente ni el chofer)', async () => {
    const delCliente = armar({ conversacion: conversacion() });
    await delCliente.servicio.enviar(
      cliente,
      'conv-1',
      { clientMessageId: 'c', body: 'Hola' },
      ahora,
    );
    expect(esperoDesde(delCliente)).toBeNull();
    const deChofer = armar({ conversacion: delChofer() });
    await deChofer.servicio.enviar(
      chofer,
      'conv-1',
      { clientMessageId: 'c', body: 'Hola' },
      ahora,
    );
    expect(esperoDesde(deChofer)).toBeNull();
  });

  it('si la tiene alguien, o ya espera, no se toca', async () => {
    const asignada = armar({
      conversacion: conversacion({ assignedToUserId: 'adm-1' }),
      consultas: prendida,
    });
    await asignada.servicio.enviar(
      cliente,
      'conv-1',
      { clientMessageId: 'c', body: 'Hola' },
      ahora,
    );
    expect(esperoDesde(asignada)).toBeNull();
    const yaEspera = armar({
      conversacion: conversacion({ awaitingHumanSince: hace(10) }),
      consultas: prendida,
    });
    await yaEspera.servicio.enviar(
      cliente,
      'conv-1',
      { clientMessageId: 'c', body: 'Hola' },
      ahora,
    );
    expect(esperoDesde(yaEspera)).toBeNull();
  });

  it('si la atiende el asistente con IA, no espera a una persona (la deriva él si hace falta)', async () => {
    const m = armar({
      conversacion: conversacion(),
      ajustes: { customerChatEnabled: true },
      ia: true,
      // El hilo trae el mensaje que disparó (el que escribe el envío, seq 9).
      consultas: (sql) =>
        sql.includes('"de_la_ia"')
          ? [
              {
                seq: '9',
                message_id: 'msg-1',
                sender_party: Party.CUSTOMER,
                kind: 'text',
                de_la_ia: false,
                created_at: ahora.toISOString(),
                retirado: false,
              },
            ]
          : prendida(sql),
    });
    await m.servicio.enviar(
      cliente,
      'conv-1',
      { clientMessageId: 'c', body: '¿Tienen garrafas de 10 kg?' },
      ahora,
    );
    expect(esperoDesde(m)).toBeNull();
  });

  it('el equipo escribe: no la deja esperando', async () => {
    const m = armar({
      conversacion: conversacion(),
      consultas: prendida,
    });
    await m.servicio.enviar(
      personal,
      'conv-1',
      { clientMessageId: 'c', body: 'Hola' },
      ahora,
    );
    expect(esperoDesde(m)).toBeNull();
  });

  it('la función apagada en la base (lo que ve el `FOR SHARE`) no marca, aunque los ajustes en memoria digan otra cosa', async () => {
    const m = armar({
      conversacion: conversacion(),
      ajustes: { autoAssignEnabled: true },
      consultas: (sql) =>
        sql.includes('FOR SHARE') ? [{ auto_assign_enabled: false }] : [],
    });
    await m.servicio.enviar(
      cliente,
      'conv-1',
      { clientMessageId: 'c', body: 'Hola' },
      ahora,
    );
    expect(esperoDesde(m)).toBeNull();
    const lectura = m.consultas.find((q) => q.includes('FOR SHARE'));
    expect(lectura).toMatch(/FROM "chat_company_settings"/);
  });

  it('«hablar con una persona» sobre una que ya esperaba por la asignación pasa a `handoff` (no se borra al apagar) y conserva su lugar', async () => {
    const desde = hace(20);
    const c = conversacion({
      awaitingHumanSince: desde,
      awaitingHumanReason: 'auto_assign',
    });
    const m = armar({ conversacion: c, consultas: prendida });
    await m.servicio.accion(
      cliente,
      'conv-1',
      { key: 'talk_to_person', clientMessageId: 'c' },
      ahora,
    );
    const i = m.consultas.findIndex((q) =>
      q.includes(`SET "awaiting_human_reason" = 'handoff'`),
    );
    expect(i).toBeGreaterThanOrEqual(0);
    expect(m.consultas[i]).toMatch(/"awaiting_human_reason" = 'auto_assign'/);
    expect(m.parametros[i]).toEqual(['conv-1']);
    expect(c.awaitingHumanReason).toBe('handoff');
    expect(c.awaitingHumanSince).toBe(desde);
    expect(esperoDesde(m)).toBeNull();
  });
});
