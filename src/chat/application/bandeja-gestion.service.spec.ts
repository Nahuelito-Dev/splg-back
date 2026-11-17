import type { DataSource, EntityManager } from 'typeorm';
import type { StaffPermissionsService } from '../../admin/staff-permissions.service';
import type { ClaimsService } from '../../claims/claims.service';
import {
  Channel,
  ConversationClosedReason,
  ConversationStatus,
  Party,
  SubjectType,
  SystemCode,
} from '../domain/chat.enums';
import { Conversation } from '../entities/conversation.entity';
import type { BandejaReadModel } from '../infrastructure/bandeja-read-model';
import { type ActorDeLaBandeja, BandejaAcceso } from './bandeja-acceso';
import {
  BandejaGestionService,
  idDelMensajeDelLote,
} from './bandeja-gestion.service';
import { type ChatEvents, Efectos } from './chat.events';
import type { ChatRateLimit } from './chat-rate-limit';
import {
  type BandejaEncuestaService,
  SQL_PARA_ANULAR,
} from './bandeja-encuesta.service';
import type { ConversationFactory } from './conversation-factory';
import type { MessageWriter } from './message-writer';

const D = 'dist-a';
const personal: ActorDeLaBandeja = {
  party: Party.COMPANY,
  userId: 'adm-1',
  distributorId: D,
  canales: [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER],
  permisos: ['mensajes.clientes', 'mensajes.choferes', 'reclamos.gestionar'],
};
const soloChoferes: ActorDeLaBandeja = {
  ...personal,
  userId: 'adm-2',
  canales: [Channel.STAFF_DRIVER],
  permisos: ['mensajes.choferes'],
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
    ...cambios,
  });
}

function armar(
  opciones: {
    conversacion?: Conversation;
    consultas?: (sql: string, params?: unknown[]) => unknown[];
    esAdminDeLaEmpresa?: boolean;
    permisosDelAsignado?: string[];
    guardar?: () => Promise<unknown>;
    /** El reclamo ya vinculado a la conversación (idempotencia). */
    claimPrevio?: Record<string, unknown> | null;
    /** El envío falla (para ver que el reclamo no se avisa). */
    escribirFalla?: boolean;
    /** El query builder del listado (para ver el filtro y el orden). */
    qb?: unknown;
  } = {},
) {
  const guardados: Conversation[] = [];
  const query = jest.fn((sql: string, params?: unknown[]) =>
    Promise.resolve(opciones.consultas?.(sql, params) ?? []),
  );
  const manager = {
    getRepository: () => ({
      save: jest.fn((c: Conversation) => {
        guardados.push({ ...c } as Conversation);
        return opciones.guardar ? opciones.guardar() : Promise.resolve(c);
      }),
      findOne: jest.fn().mockResolvedValue(opciones.claimPrevio ?? null),
      findOneByOrFail: jest
        .fn()
        .mockResolvedValue(opciones.conversacion ?? conversacion()),
    }),
    query,
  } as unknown as EntityManager;
  const transaction = jest.fn((fn: (m: EntityManager) => Promise<unknown>) =>
    fn(manager),
  );
  const dataSource = {
    manager,
    query,
    transaction,
    getRepository: () => ({ createQueryBuilder: () => opciones.qb }),
  } as unknown as DataSource;
  const acceso = new BandejaAcceso(
    dataSource,
    {} as unknown as StaffPermissionsService,
  );
  jest
    .spyOn(acceso, 'buscar')
    .mockResolvedValue(opciones.conversacion ?? conversacion());
  const claims = {
    crearDentro: jest.fn().mockResolvedValue({ claimId: 'cl-1' }),
    avisarCreado: jest.fn(),
  };
  const respuestaDelEnvio = {
    created: true,
    message: { seq: 5 },
    conversation: opciones.conversacion ?? conversacion(),
  };
  const escribir = jest.fn<Promise<unknown>, [unknown, unknown]>(() =>
    opciones.escribirFalla
      ? Promise.reject(new Error('falla después del reclamo'))
      : Promise.resolve(respuestaDelEnvio),
  );
  const crear = jest
    .fn()
    .mockResolvedValue(conversacion({ conversationId: 'conv-nueva' }));
  const publicados: Efectos[] = [];
  const cupos = { mensaje: jest.fn() };
  const encuesta = { pedirAlCerrar: jest.fn(() => Promise.resolve(true)) };
  const servicio = new BandejaGestionService(
    dataSource,
    acceso,
    {
      adminDeLaEmpresa: jest
        .fn()
        .mockResolvedValue(opciones.esAdminDeLaEmpresa ?? true),
    } as unknown as BandejaReadModel,
    {
      deUsuario: jest.fn().mockResolvedValue({
        permisos: opciones.permisosDelAsignado ?? ['mensajes.clientes'],
      }),
    } as unknown as StaffPermissionsService,
    { escribir } as unknown as MessageWriter,
    { crear } as unknown as ConversationFactory,
    claims as unknown as ClaimsService,
    cupos as unknown as ChatRateLimit,
    { publicar: (e: Efectos) => publicados.push(e) } as unknown as ChatEvents,
    encuesta as unknown as BandejaEncuestaService,
  );
  return {
    servicio,
    manager,
    encuesta,
    query,
    transaction,
    guardados,
    claims,
    escribir,
    crear,
    publicados,
    cupos,
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

describe('BandejaGestionService: listar (§14.3)', () => {
  it('pedir C3 sin `mensajes.clientes` → 403 (no lista ni filtra en silencio)', async () => {
    const { servicio } = armar();
    expect(
      await codigo(
        servicio.listar(soloChoferes, {
          channel: Channel.STAFF_CUSTOMER,
          limit: 20,
          offset: 0,
        }),
      ),
    ).toBe('PERMISSION_DENIED');
  });
});

describe('BandejaGestionService: la cola de las que esperan a una persona (B3)', () => {
  const qbQueAnota = () => {
    const llamadas: unknown[][] = [];
    const qb: Record<string, jest.Mock> = {};
    for (const m of [
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'take',
      'skip',
    ]) {
      qb[m] = jest.fn((...args: unknown[]) => {
        llamadas.push([m, ...args]);
        return qb;
      });
    }
    qb.getManyAndCount = jest.fn(() => Promise.resolve([[], 0]));
    return { qb, llamadas };
  };
  const pagina = { limit: 20, offset: 0 };

  it('«sin asignar»: primero las que esperan (la más vieja primero), después el orden de siempre', async () => {
    const { qb, llamadas } = qbQueAnota();
    await armar({ qb }).servicio.listar(personal, {
      ...pagina,
      assigned: 'none',
    });
    const orden = llamadas.filter(([m]) => String(m).endsWith('rderBy'));
    expect(orden).toEqual([
      ['orderBy', 'c.awaitingHumanSince', 'ASC', 'NULLS LAST'],
      ['addOrderBy', 'c.lastMessageAt', 'DESC', 'NULLS LAST'],
      ['addOrderBy', 'c.createdAt', 'DESC'],
      ['addOrderBy', 'c.conversationId', 'ASC'],
    ]);
  });

  it('sin «sin asignar», el orden de hoy (el último mensaje primero)', async () => {
    const { qb, llamadas } = qbQueAnota();
    await armar({ qb }).servicio.listar(personal, {
      ...pagina,
      assigned: 'me',
    });
    expect(llamadas.find(([m]) => String(m).endsWith('rderBy'))).toEqual([
      'addOrderBy',
      'c.lastMessageAt',
      'DESC',
      'NULLS LAST',
    ]);
    expect(
      llamadas.some((l) => String(l[1]).includes('awaitingHumanSince')),
    ).toBe(false);
  });

  it('`awaiting`: true, sólo las que esperan; false, sólo las que no', async () => {
    for (const [awaiting, condicion] of [
      [true, 'c.awaitingHumanSince IS NOT NULL'],
      [false, 'c.awaitingHumanSince IS NULL'],
    ] as const) {
      const { qb, llamadas } = qbQueAnota();
      await armar({ qb }).servicio.listar(personal, { ...pagina, awaiting });
      expect(llamadas).toContainEqual(['andWhere', condicion]);
    }
  });
});

describe('BandejaGestionService: «Me mencionaron» (4a)', () => {
  const qbQueAnota = () => {
    const llamadas: unknown[][] = [];
    const qb: Record<string, jest.Mock> = {};
    for (const m of [
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'take',
      'skip',
    ]) {
      qb[m] = jest.fn((...args: unknown[]) => {
        llamadas.push([m, ...args]);
        return qb;
      });
    }
    qb.getManyAndCount = jest.fn(() => Promise.resolve([[], 0]));
    return { qb, llamadas };
  };
  const mencion = (llamadas: unknown[][]) =>
    llamadas.find(
      ([m, sql]) => m === 'andWhere' && String(sql).includes('message_mention'),
    ) as [string, string, Record<string, unknown>] | undefined;

  it('`mentioned=me`: las que tienen una nota de ESTA empresa que menciona a quien pide (leída o no)', async () => {
    const { qb, llamadas } = qbQueAnota();
    await armar({ qb }).servicio.listar(personal, {
      limit: 20,
      offset: 0,
      mentioned: 'me',
    });
    const [, sql, params] = mencion(llamadas)!;
    expect(sql).toContain('mm."distributor_id" = :distributorId');
    expect(sql).toContain('mm."mentioned_user_id" = :mencionado');
    expect(sql).not.toContain('read_at');
    expect(params).toEqual({ mencionado: personal.userId });
    // La empresa del filtro es la de quien pide (el `where` de siempre).
    expect(llamadas).toContainEqual([
      'where',
      'c.distributorId = :distributorId',
      { distributorId: personal.distributorId },
    ]);
  });

  it('`mentioned=unread`: sólo con menciones sin leer; sin el filtro, no se mira', async () => {
    const sinLeer = qbQueAnota();
    await armar({ qb: sinLeer.qb }).servicio.listar(personal, {
      limit: 20,
      offset: 0,
      mentioned: 'unread',
    });
    expect(mencion(sinLeer.llamadas)![1]).toContain('mm."read_at" IS NULL');
    const todas = qbQueAnota();
    await armar({ qb: todas.qb }).servicio.listar(personal, {
      limit: 20,
      offset: 0,
    });
    expect(mencion(todas.llamadas)).toBeUndefined();
  });
});

describe('BandejaGestionService: filtro por etiqueta (7c)', () => {
  const qbQueAnota = () => {
    const llamadas: unknown[][] = [];
    const qb: Record<string, jest.Mock> = {};
    for (const m of [
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'take',
      'skip',
    ]) {
      qb[m] = jest.fn((...args: unknown[]) => {
        llamadas.push([m, ...args]);
        return qb;
      });
    }
    qb.getManyAndCount = jest.fn(() => Promise.resolve([[], 0]));
    return { qb, llamadas };
  };
  const filtro = (llamadas: unknown[][]) =>
    llamadas.find(
      ([m, sql]) =>
        m === 'andWhere' && String(sql).includes('conversation_label_link'),
    ) as [string, string, Record<string, unknown>] | undefined;

  it('`labelId`: sólo las que tienen esa etiqueta vigente de ESTA empresa', async () => {
    const { qb, llamadas } = qbQueAnota();
    await armar({ qb }).servicio.listar(personal, {
      limit: 20,
      offset: 0,
      labelId: 'et-1',
    });
    const [, sql, params] = filtro(llamadas)!;
    expect(sql).toContain('k."distributor_id" = :distributorId');
    expect(sql).toContain('k."deleted_at" IS NULL AND l."deleted_at" IS NULL');
    expect(sql).toContain('l."distributor_id" = k."distributor_id"');
    expect(params).toEqual({ etiqueta: 'et-1' });
  });

  it('sin `labelId`, no filtra por etiqueta', async () => {
    const { qb, llamadas } = qbQueAnota();
    await armar({ qb }).servicio.listar(personal, { limit: 20, offset: 0 });
    expect(filtro(llamadas)).toBeUndefined();
  });
});

describe('BandejaGestionService: asignar', () => {
  it('a un admin de otra empresa → 404 (no se confirma que exista)', async () => {
    const { servicio, guardados } = armar({ esAdminDeLaEmpresa: false });
    expect(await codigo(servicio.asignar(personal, 'conv-1', 'adm-b'))).toBe(
      '404',
    );
    expect(guardados).toEqual([]);
  });

  it('a quien no atiende ese canal → 400 ASSIGNEE_WITHOUT_PERMISSION', async () => {
    const { servicio } = armar({ permisosDelAsignado: ['mensajes.choferes'] });
    expect(await codigo(servicio.asignar(personal, 'conv-1', 'adm-2'))).toBe(
      'ASSIGNEE_WITHOUT_PERMISSION',
    );
  });

  it('a alguien del canal: guarda y avisa; `null` la devuelve a la cola', async () => {
    const { servicio, guardados, publicados } = armar();
    await servicio.asignar(personal, 'conv-1', 'adm-3');
    expect(guardados[0].assignedToUserId).toBe('adm-3');
    expect(publicados[0].conversaciones[0].change).toBe('assigned');
    const otro = armar({
      conversacion: conversacion({ assignedToUserId: 'adm-3' }),
    });
    await otro.servicio.asignar(personal, 'conv-1', null);
    expect(otro.guardados[0].assignedToUserId).toBeNull();
  });

  it('tomar una que el asistente con IA derivó deja de esperar a una persona; devolverla a la cola no la marca', async () => {
    const derivada = new Date('2026-11-15T12:00:00Z');
    const { servicio, guardados } = armar({
      conversacion: conversacion({ awaitingHumanSince: derivada }),
    });
    await servicio.asignar(personal, 'conv-1', 'adm-3');
    expect(guardados[0].awaitingHumanSince).toBeNull();
    const cola = armar({
      conversacion: conversacion({
        assignedToUserId: 'adm-3',
        awaitingHumanSince: derivada,
      }),
    });
    await cola.servicio.asignar(personal, 'conv-1', null);
    expect(cola.guardados[0].awaitingHumanSince).toBe(derivada);
  });

  it('una cerrada → 409', async () => {
    const { servicio } = armar({
      conversacion: conversacion({ status: ConversationStatus.CLOSED }),
    });
    expect(await codigo(servicio.asignar(personal, 'conv-1', 'adm-3'))).toBe(
      'CONVERSATION_CLOSED',
    );
  });
});

describe('BandejaGestionService: mensaje a varios choferes (§4.4)', () => {
  it('con uno de otra empresa → 404 y no se manda a ninguno (ni abre la transacción)', async () => {
    const { servicio, transaction, escribir } = armar({
      consultas: () => [{ user_id: 'cho-1' }, { user_id: 'cho-2' }],
    });
    expect(
      await codigo(
        servicio.difundir(personal, {
          driverIds: ['cho-1', 'cho-2', 'cho-de-b'],
          body: 'Hoy cerramos a las 18.',
          clientBatchId: 'lote-1',
        }),
      ),
    ).toBe('404');
    expect(transaction).not.toHaveBeenCalled();
    expect(escribir).not.toHaveBeenCalled();
  });

  it('sin `mensajes.choferes` → 403', async () => {
    const { servicio } = armar();
    expect(
      await codigo(
        servicio.difundir(
          { ...personal, canales: [Channel.STAFF_CUSTOMER] },
          { driverIds: ['cho-1'], body: 'x', clientBatchId: 'l' },
        ),
      ),
    ).toBe('PERMISSION_DENIED');
  });

  it('todos de la empresa: uno por chofer en su general, con id de mensaje que sale del lote', async () => {
    const { servicio, escribir, crear, cupos } = armar({
      consultas: (sql) =>
        sql.includes('FROM "delivery"')
          ? [{ user_id: 'cho-1' }, { user_id: 'cho-2' }]
          : [],
    });
    const r = await servicio.difundir(personal, {
      driverIds: ['cho-2', 'cho-1'],
      body: 'Hoy cerramos a las 18.',
      clientBatchId: 'lote-1',
    });
    expect(r.sent).toBe(2);
    expect(crear).toHaveBeenCalledTimes(2);
    // La marca del lote lleva la empresa: el mismo lote en otra no es reintento.
    expect(cupos.mensaje).toHaveBeenCalledWith({
      ambito: D,
      userId: 'adm-1',
      clientMessageId: 'lote-1',
    });
    const ids = escribir.mock.calls.map(
      ([, n]) => (n as { clientMessageId: string }).clientMessageId,
    );
    expect(ids.sort()).toEqual(
      [
        idDelMensajeDelLote('lote-1', 'cho-1'),
        idDelMensajeDelLote('lote-1', 'cho-2'),
      ].sort(),
    );
  });

  it('el id de cada mensaje es estable y con forma de uuid', () => {
    const a = idDelMensajeDelLote('lote-1', 'cho-1');
    expect(a).toBe(idDelMensajeDelLote('lote-1', 'cho-1'));
    expect(a).not.toBe(idDelMensajeDelLote('lote-2', 'cho-1'));
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('BandejaGestionService: reclamo desde el hilo (§4.3)', () => {
  const dto = { reason: 'Pérdida', description: 'Pierde gas' };

  it('sin `reclamos.gestionar` → 403', async () => {
    const { servicio } = armar();
    expect(
      await codigo(
        servicio.crearReclamo(
          { ...personal, permisos: ['mensajes.clientes'] },
          'conv-1',
          dto,
        ),
      ),
    ).toBe('PERMISSION_DENIED');
  });

  it('ya tiene otro reclamo → 409; general sin pedido → 400; pedido distinto → 400', async () => {
    const conReclamo = armar({
      conversacion: conversacion({ linkedClaimId: 'cl-0' }),
      claimPrevio: { orderId: 'p-9', reason: 'Otro', description: 'Otro' },
    });
    expect(
      await codigo(conReclamo.servicio.crearReclamo(personal, 'conv-1', dto)),
    ).toBe('CONVERSATION_ALREADY_HAS_CLAIM');
    const sinPedido = armar();
    expect(
      await codigo(sinPedido.servicio.crearReclamo(personal, 'conv-1', dto)),
    ).toBe('400');
    const otroPedido = armar({
      conversacion: conversacion({
        subjectType: SubjectType.ORDER,
        orderId: 'p-1',
      }),
    });
    expect(
      await codigo(
        otroPedido.servicio.crearReclamo(personal, 'conv-1', {
          ...dto,
          orderId: 'p-2',
        }),
      ),
    ).toBe('400');
  });

  it('por pedido: lo crea en la MISMA transacción, la vincula y avisa después del commit', async () => {
    const { servicio, claims, escribir } = armar({
      conversacion: conversacion({
        subjectType: SubjectType.ORDER,
        orderId: 'p-1',
      }),
    });
    const r = await servicio.crearReclamo(personal, 'conv-1', dto);
    expect(claims.crearDentro).toHaveBeenCalledWith(
      expect.anything(),
      { orderId: 'p-1', customerId: 'cli-1', ...dto },
      D,
    );
    expect(r).toMatchObject({ claimId: 'cl-1', created: true });
    expect(escribir).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ payload: { claimId: 'cl-1' } }),
    );
    expect(claims.avisarCreado).toHaveBeenCalledWith({ claimId: 'cl-1' });
  });

  it('con la conversación cerrada → 409 antes de crear el reclamo', async () => {
    const { servicio, claims } = armar({
      conversacion: conversacion({
        status: ConversationStatus.CLOSED,
        subjectType: SubjectType.ORDER,
        orderId: 'p-1',
      }),
    });
    expect(await codigo(servicio.crearReclamo(personal, 'conv-1', dto))).toBe(
      'CONVERSATION_CLOSED',
    );
    expect(claims.crearDentro).not.toHaveBeenCalled();
    expect(claims.avisarCreado).not.toHaveBeenCalled();
  });

  it('si algo falla después de crearlo, no se avisa (la transacción lo deshace)', async () => {
    const { servicio, claims } = armar({
      conversacion: conversacion({
        subjectType: SubjectType.ORDER,
        orderId: 'p-1',
      }),
      escribirFalla: true,
    });
    await expect(
      servicio.crearReclamo(personal, 'conv-1', dto),
    ).rejects.toThrow('falla después del reclamo');
    expect(claims.avisarCreado).not.toHaveBeenCalled();
  });

  it('repetir el mismo reclamo devuelve el ya creado, sin duplicar ni avisar', async () => {
    const { servicio, claims } = armar({
      conversacion: conversacion({
        subjectType: SubjectType.ORDER,
        orderId: 'p-1',
        linkedClaimId: 'cl-1',
      }),
      claimPrevio: { orderId: 'p-1', ...dto },
    });
    const r = await servicio.crearReclamo(personal, 'conv-1', dto);
    expect(r).toMatchObject({ claimId: 'cl-1', created: false });
    expect(claims.crearDentro).not.toHaveBeenCalled();
    expect(claims.avisarCreado).not.toHaveBeenCalled();
  });
});

describe('BandejaGestionService: cerrar y reabrir', () => {
  it('cerrar una cerrada → 409', async () => {
    const { servicio } = armar({
      conversacion: conversacion({ status: ConversationStatus.CLOSED }),
    });
    expect(await codigo(servicio.cerrar(personal, 'conv-1'))).toBe(
      'CONVERSATION_CLOSED',
    );
  });

  it('reabrir con otra abierta del mismo tema (único violado) → 409 CONVERSATION_NOT_REOPENABLE', async () => {
    const { servicio } = armar({
      conversacion: conversacion({ status: ConversationStatus.CLOSED }),
      guardar: () =>
        Promise.reject(Object.assign(new Error('dup'), { code: '23505' })),
    });
    expect(await codigo(servicio.reabrir(personal, 'conv-1'))).toBe(
      'CONVERSATION_NOT_REOPENABLE',
    );
  });

  it('cerrar y reabrir dejan de esperar a una persona (el asistente con IA la había derivado)', async () => {
    const derivada = new Date('2026-11-15T12:00:00Z');
    const cerrar = armar({
      conversacion: conversacion({ awaitingHumanSince: derivada }),
    });
    await cerrar.servicio.cerrar(personal, 'conv-1');
    expect(cerrar.guardados[0]).toMatchObject({
      status: ConversationStatus.CLOSED,
      awaitingHumanSince: null,
    });
    const reabrir = armar({
      conversacion: conversacion({
        status: ConversationStatus.CLOSED,
        awaitingHumanSince: derivada,
      }),
    });
    await reabrir.servicio.reabrir(personal, 'conv-1');
    expect(reabrir.guardados[0]).toMatchObject({
      status: ConversationStatus.OPEN,
      awaitingHumanSince: null,
    });
  });

  it('cerrar pide la encuesta (4b) dentro del cierre, con la conversación todavía abierta y antes de guardarla cerrada', async () => {
    const t = armar();
    const ahora = new Date('2026-11-15T15:00:00Z');
    let estadoAlPedir: ConversationStatus | undefined;
    t.encuesta.pedirAlCerrar.mockImplementationOnce(((
      _m: unknown,
      c: Conversation,
    ) => {
      estadoAlPedir = c.status;
      expect(t.guardados).toEqual([]);
      return Promise.resolve(true);
    }) as never);
    await t.servicio.cerrar(personal, 'conv-1', ahora);
    expect(t.encuesta.pedirAlCerrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'conv-1' }),
      expect.anything(),
      ahora,
    );
    expect(estadoAlPedir).toBe(ConversationStatus.OPEN);
    expect(t.guardados[0]).toMatchObject({
      status: ConversationStatus.CLOSED,
      closedAt: ahora,
    });
  });

  it('cierre por inactividad (7c): mensaje `closed_inactivity`, motivo `inactivity`, sin persona y con la encuesta', async () => {
    const t = armar({
      conversacion: conversacion({ awaitingHumanSince: null }),
    });
    const ahora = new Date('2026-11-16T15:00:00Z');
    await t.servicio.cerrarDentro(
      t.manager,
      conversacion(),
      ConversationClosedReason.INACTIVITY,
      null,
      new Efectos(),
      ahora,
    );
    expect(t.escribir).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ systemCode: SystemCode.CLOSED_INACTIVITY }),
    );
    expect(t.encuesta.pedirAlCerrar).toHaveBeenCalledTimes(1);
    expect(t.guardados[0]).toMatchObject({
      status: ConversationStatus.CLOSED,
      closedAt: ahora,
      closedReason: ConversationClosedReason.INACTIVITY,
      closedByUserId: null,
    });
  });

  it('cerrar a mano sigue con `closed_manual`, motivo `manual` y quién cerró', async () => {
    const t = armar();
    await t.servicio.cerrar(personal, 'conv-1');
    expect(t.escribir).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ systemCode: SystemCode.CLOSED_MANUAL }),
    );
    expect(t.guardados[0]).toMatchObject({
      closedReason: ConversationClosedReason.MANUAL,
      closedByUserId: personal.userId,
    });
  });

  it('cerrar una ya cerrada no pide encuesta', async () => {
    const t = armar({
      conversacion: conversacion({ status: ConversationStatus.CLOSED }),
    });
    await codigo(t.servicio.cerrar(personal, 'conv-1'));
    expect(t.encuesta.pedirAlCerrar).not.toHaveBeenCalled();
  });

  it('reabrir anula la encuesta pendiente de ese cierre (4b), en la misma transacción y antes del aviso de reapertura', async () => {
    const t = armar({
      conversacion: conversacion({ status: ConversationStatus.CLOSED }),
    });
    await t.servicio.reabrir(personal, 'conv-1');
    const anular = t.query.mock.calls.find(([sql]) => sql === SQL_PARA_ANULAR);
    expect(anular?.[1]).toEqual(['conv-1', 'dist-a', expect.any(Date)]);
    const iAnular =
      t.query.mock.invocationCallOrder[
        t.query.mock.calls.findIndex(([sql]) => sql === SQL_PARA_ANULAR)
      ];
    expect(iAnular).toBeLessThan(t.escribir.mock.invocationCallOrder[0]);
  });

  it('reabrir una abierta no anula nada', async () => {
    const t = armar();
    await t.servicio.reabrir(personal, 'conv-1');
    expect(t.query.mock.calls.some(([sql]) => sql === SQL_PARA_ANULAR)).toBe(
      false,
    );
  });

  it('reabrir una abierta la deja igual', async () => {
    const { servicio, guardados } = armar();
    await servicio.reabrir(personal, 'conv-1');
    expect(guardados).toEqual([]);
  });
});
