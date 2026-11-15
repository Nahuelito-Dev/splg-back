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
import { BandejaService } from './bandeja.service';
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
    expect(cupos.mensaje).toHaveBeenCalledWith('cli-1', 'c', 'conv-nueva');
    await servicio.enviar(cliente, 'conv-1', {
      clientMessageId: 'd',
      body: 'x',
    });
    expect(cupos.mensaje).toHaveBeenLastCalledWith('cli-1', 'd', 'conv-1');
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
