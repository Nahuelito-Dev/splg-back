import type { DataSource, EntityManager } from 'typeorm';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
  SystemCode,
} from '../domain/chat.enums';
import {
  CalificacionAnuladaError,
  CalificacionNoDisponibleError,
  CalificacionVencidaError,
  CalificacionYaRespondidaError,
  ConversacionNoEncontradaError,
} from '../domain/chat.errors';
import { Conversation } from '../entities/conversation.entity';
import { ConversationRating } from '../entities/conversation-rating.entity';
import type { ActorDeLaBandeja, BandejaAcceso } from './bandeja-acceso';
import {
  anularEncuestasPendientes,
  BandejaEncuestaService,
  PLANTILLA_DE_LA_ENCUESTA,
  resumirEncuestas,
  SQL_DE_LA_ENCUESTA_A_RESPONDER,
  SQL_DEL_RESUMEN,
  SQL_PARA_ANULAR,
  sqlDeQuienAtendio,
} from './bandeja-encuesta.service';
import type { ChatEvents, Efectos } from './chat.events';
import { Efectos as EfectosReales } from './chat.events';
import {
  ajustesDeLaBandejaPorDefecto,
  type CompanyChatSettingsService,
} from './company-chat-settings.service';
import type { MessageWriter } from './message-writer';
import type { NuevoMensaje } from './mensajes.port';

const A = 'dist-a';
const B = 'dist-b';
const AHORA = new Date('2026-11-15T15:00:00Z');

const cliente = (distributorId = A): ActorDeLaBandeja => ({
  party: Party.CUSTOMER,
  userId: 'cli-1',
  distributorId,
  canales: [Channel.STAFF_CUSTOMER],
  permisos: [],
});

function c3(cambios: Partial<Conversation> = {}): Conversation {
  return Object.assign(new Conversation(), {
    conversationId: 'conv-1',
    distributorId: A,
    channel: Channel.STAFF_CUSTOMER,
    status: ConversationStatus.CLOSED,
    customerUserId: 'cli-1',
    driverUserId: null,
    orderId: null,
    ...cambios,
  });
}

function encuesta(
  cambios: Partial<ConversationRating> = {},
): ConversationRating {
  return Object.assign(new ConversationRating(), {
    ratingId: 'r-1',
    conversationId: 'conv-1',
    distributorId: A,
    requestMessageId: 'm-9',
    customerUserId: 'cli-1',
    servedBy: 'team',
    score: null,
    comment: null,
    requestedAt: new Date('2026-11-15T12:00:00Z'),
    expiresAt: new Date('2026-11-17T12:00:00Z'),
    answeredAt: null,
    cancelledAt: null,
    ...cambios,
  });
}

/** La fila como la devuelve `SQL_DE_LA_ENCUESTA_A_RESPONDER`. */
function fila(e: ConversationRating) {
  return {
    rating_id: e.ratingId,
    conversation_id: e.conversationId,
    distributor_id: e.distributorId,
    request_message_id: e.requestMessageId,
    customer_user_id: e.customerUserId,
    served_by: e.servedBy,
    score: e.score,
    comment: e.comment,
    requested_at: e.requestedAt,
    expires_at: e.expiresAt,
    answered_at: e.answeredAt,
    cancelled_at: e.cancelledAt,
  };
}

function armar(
  o: {
    csatEnabled?: boolean;
    quien?: { equipo: boolean; asistente: boolean };
    encuesta?: ConversationRating | null;
    filas?: unknown[];
    abierta?: boolean;
  } = {},
) {
  const escritos: NuevoMensaje[] = [];
  const insertadas: unknown[] = [];
  const actualizadas: unknown[] = [];
  const buscadas: unknown[] = [];
  const consultas: Array<[string, unknown[]]> = [];
  const repo = {
    insert: jest.fn((fila: unknown) => {
      insertadas.push(fila);
      return Promise.resolve();
    }),
    findOne: jest.fn((opciones: unknown) => {
      buscadas.push(opciones);
      return Promise.resolve(
        o.encuesta === undefined ? encuesta() : o.encuesta,
      );
    }),
    update: jest.fn((_w: unknown, cambios: unknown) => {
      actualizadas.push(cambios);
      return Promise.resolve();
    }),
  };
  const manager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      consultas.push([sql, params]);
      if (sql === SQL_DE_LA_ENCUESTA_A_RESPONDER) {
        buscadas.push(params);
        const e = o.encuesta === undefined ? encuesta() : o.encuesta;
        return Promise.resolve(e ? [fila(e)] : []);
      }
      if (sql.includes('AS equipo')) {
        return Promise.resolve([o.quien ?? { equipo: false, asistente: true }]);
      }
      // valoresDePlantilla: el nombre del cliente y el de la empresa.
      return Promise.resolve([{ name: 'Gas Norte', full_name: 'Ana' }]);
    }),
    getRepository: jest.fn((entidad: unknown) => {
      expect(entidad).toBe(ConversationRating);
      return repo;
    }),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn((cb: (m: EntityManager) => unknown) => cb(manager)),
    query: jest.fn((sql: string, params: unknown[]) => {
      consultas.push([sql, params]);
      return Promise.resolve(o.filas ?? []);
    }),
  } as unknown as DataSource;
  const acceso = {
    buscar: jest.fn((a: ActorDeLaBandeja) =>
      a.distributorId === A
        ? Promise.resolve(
            c3(o.abierta ? { status: ConversationStatus.OPEN } : {}),
          )
        : Promise.reject(new ConversacionNoEncontradaError()),
    ),
  };
  const ajustes = {
    leer: jest.fn(() =>
      Promise.resolve({
        ...ajustesDeLaBandejaPorDefecto(A),
        csatEnabled: o.csatEnabled ?? true,
      }),
    ),
  };
  const writer = {
    escribir: jest.fn((_m: unknown, nuevo: NuevoMensaje) => {
      escritos.push(nuevo);
      return Promise.resolve({
        message: { ...nuevo, messageId: 'm-9', seq: 9 },
        created: true,
        conversation: c3(),
      });
    }),
  };
  const publicados: Efectos[] = [];
  const servicio = new BandejaEncuestaService(
    dataSource,
    acceso as unknown as BandejaAcceso,
    ajustes as unknown as CompanyChatSettingsService,
    writer as unknown as MessageWriter,
    {
      publicar: (e: Efectos) => publicados.push(e),
    } as unknown as ChatEvents,
  );
  return {
    servicio,
    manager,
    escritos,
    insertadas,
    actualizadas,
    buscadas,
    consultas,
    publicados,
    acceso,
  };
}

describe('BandejaEncuestaService: pedir la encuesta al cerrar (4b)', () => {
  it('con un cliente y la encuesta prendida: el mensaje `csat_request` y la encuesta de ese cierre (48 h, quién atendió)', async () => {
    const t = armar({ quien: { equipo: false, asistente: true } });
    const efectos = new EfectosReales();
    expect(
      await t.servicio.pedirAlCerrar(t.manager, c3(), efectos, AHORA),
    ).toBe(true);
    expect(t.escritos).toHaveLength(1);
    const pedido = t.escritos[0];
    expect(pedido).toMatchObject({
      conversationId: 'conv-1',
      distributorId: A,
      senderParty: Party.SYSTEM,
      senderUserId: null,
      kind: MessageKind.SYSTEM,
      visibility: MessageVisibility.ALL,
      systemCode: SystemCode.CSAT_REQUEST,
      templateKey: PLANTILLA_DE_LA_ENCUESTA,
    });
    expect(pedido.body).toContain('Tocá de 1 a 5');
    const payload = pedido.payload as {
      ratingId: string;
      expiresAt: string;
      scale: number;
    };
    expect(payload).toEqual({
      ratingId: expect.any(String) as unknown,
      expiresAt: '2026-11-17T15:00:00.000Z',
      scale: 5,
    });
    expect(t.insertadas).toEqual([
      {
        ratingId: payload.ratingId,
        conversationId: 'conv-1',
        distributorId: A,
        requestMessageId: 'm-9',
        customerUserId: 'cli-1',
        servedBy: 'assistant',
        score: null,
        comment: null,
        requestedAt: AHORA,
        expiresAt: new Date('2026-11-17T15:00:00.000Z'),
        answeredAt: null,
      },
    ]);
    expect(efectos.mensajes).toHaveLength(1);
    // Quién atendió: el equipo, sólo con texto visible (las notas internas no cuentan).
    expect(t.consultas.find(([sql]) => sql.includes('AS equipo'))?.[0]).toMatch(
      /"sender_party" = 'company' AND "kind" = 'text'\s+AND "visibility" = 'all'\) AS equipo/,
    );
  });

  it('el equipo escribió: `served_by: team`', async () => {
    const t = armar({ quien: { equipo: true, asistente: true } });
    await t.servicio.pedirAlCerrar(t.manager, c3(), new EfectosReales(), AHORA);
    expect(t.insertadas[0]).toMatchObject({ servedBy: 'team' });
  });

  it.each<[string, Conversation, boolean]>([
    [
      'con un chofer (C2)',
      c3({
        channel: Channel.STAFF_DRIVER,
        customerUserId: null,
        driverUserId: 'cho-1',
      }),
      true,
    ],
    ['con la encuesta apagada', c3(), false],
  ])('%s: no sale nada', async (_caso, conversacion, prendida) => {
    const t = armar({ csatEnabled: prendida });
    expect(
      await t.servicio.pedirAlCerrar(
        t.manager,
        conversacion,
        new EfectosReales(),
        AHORA,
      ),
    ).toBe(false);
    expect(t.escritos).toEqual([]);
    expect(t.insertadas).toEqual([]);
  });
});

describe('BandejaEncuestaService: responder (4b)', () => {
  const respuesta = { ratingId: 'r-1', score: 4, comment: 'Bien' };

  it('el cliente responde ESA encuesta (por `ratingId`) de su conversación: guarda puntaje, comentario y cuándo; avisa', async () => {
    const t = armar();
    const r = await t.servicio.responder(cliente(), 'conv-1', respuesta, AHORA);
    expect(r.created).toBe(true);
    expect(r.rating).toMatchObject({
      ratingId: 'r-1',
      score: 4,
      comment: 'Bien',
      answeredAt: AHORA,
    });
    expect(t.actualizadas).toEqual([
      { score: 4, comment: 'Bien', answeredAt: AHORA },
    ]);
    // ESA encuesta, de ESA conversación, empresa y cliente (no «la última»).
    expect(t.buscadas).toEqual([['r-1', 'conv-1', A, 'cli-1']]);
    expect(t.publicados[0].conversaciones).toEqual([
      expect.objectContaining({ change: 'status' }),
    ]);
  });

  it('dos cierres: se responde la del primero por su id aunque haya una más nueva', async () => {
    const t = armar({
      encuesta: encuesta({
        ratingId: 'r-viejo',
        requestedAt: new Date('2026-11-15T13:00:00Z'),
      }),
    });
    const r = await t.servicio.responder(
      cliente(),
      'conv-1',
      { ratingId: 'r-viejo', score: 2 },
      AHORA,
    );
    expect(r.rating.ratingId).toBe('r-viejo');
    expect(t.buscadas[0]).toEqual(['r-viejo', 'conv-1', A, 'cli-1']);
  });

  it('sin comentario, queda nulo', async () => {
    const t = armar();
    await t.servicio.responder(
      cliente(),
      'conv-1',
      { ratingId: 'r-1', score: 1 },
      AHORA,
    );
    expect(t.actualizadas[0]).toMatchObject({ score: 1, comment: null });
  });

  it('reintento con la misma respuesta: 200 con la guardada, sin volver a guardar ni avisar', async () => {
    const t = armar({
      encuesta: encuesta({
        score: 4,
        comment: 'Bien',
        answeredAt: new Date('2026-11-15T14:00:00Z'),
      }),
    });
    const r = await t.servicio.responder(cliente(), 'conv-1', respuesta, AHORA);
    expect(r.created).toBe(false);
    expect(r.rating.score).toBe(4);
    expect(t.actualizadas).toEqual([]);
    expect(t.publicados[0].conversaciones).toEqual([]);
  });

  it.each<[string, ConversationRating | null, boolean, unknown]>([
    [
      'otra encuesta (de otra conversación o persona) → 404',
      null,
      false,
      CalificacionNoDisponibleError,
    ],
    [
      'ya respondida con otra cosa → 409',
      encuesta({ score: 5, answeredAt: new Date('2026-11-15T13:00:00Z') }),
      false,
      CalificacionYaRespondidaError,
    ],
    [
      'anulada al reabrir → 409',
      encuesta({ cancelledAt: new Date('2026-11-15T13:00:00Z') }),
      false,
      CalificacionAnuladaError,
    ],
    [
      'con la conversación abierta → 409',
      encuesta(),
      true,
      CalificacionAnuladaError,
    ],
    [
      'vencida → 409',
      encuesta({ expiresAt: new Date('2026-11-15T14:59:59Z') }),
      false,
      CalificacionVencidaError,
    ],
  ])('%s, sin guardar nada', async (_caso, e, abierta, error) => {
    const t = armar({ encuesta: e, abierta });
    await expect(
      t.servicio.responder(cliente(), 'conv-1', respuesta, AHORA),
    ).rejects.toBeInstanceOf(error as new () => Error);
    expect(t.actualizadas).toEqual([]);
  });

  it('el chofer → 403 CUSTOMER_ONLY', async () => {
    const t = armar();
    await expect(
      t.servicio.responder(
        { ...cliente(), party: Party.DRIVER, canales: [Channel.STAFF_DRIVER] },
        'conv-1',
        respuesta,
        AHORA,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(t.acceso.buscar).not.toHaveBeenCalled();
  });

  it('dos empresas: la conversación de A pedida con el X-Distributor de B → 404, sin tocar la encuesta', async () => {
    const t = armar();
    await expect(
      t.servicio.responder(cliente(B), 'conv-1', respuesta, AHORA),
    ).rejects.toBeInstanceOf(ConversacionNoEncontradaError);
    expect(t.buscadas).toEqual([]);
  });

  it('el SQL busca por id, conversación, empresa y cliente, y bloquea la fila', () => {
    for (const c of [
      '"rating_id" = $1',
      '"conversation_id" = $2',
      '"distributor_id" = $3',
      '"customer_user_id" = $4',
      'FOR UPDATE',
    ]) {
      expect(SQL_DE_LA_ENCUESTA_A_RESPONDER).toContain(c);
    }
  });
});

describe('BandejaEncuestaService: anular al reabrir y quién atendió (4b)', () => {
  it('anular: sólo las pendientes (ni respondidas ni anuladas) de esa conversación y empresa; cuenta las anuladas', async () => {
    const query = jest.fn(() => Promise.resolve([[{ rating_id: 'r-1' }], 1]));
    expect(
      await anularEncuestasPendientes({ query } as never, 'conv-1', A, AHORA),
    ).toBe(1);
    expect(query).toHaveBeenCalledWith(SQL_PARA_ANULAR, ['conv-1', A, AHORA]);
    for (const c of [
      '"conversation_id" = $1',
      '"distributor_id" = $2',
      '"answered_at" IS NULL',
      '"cancelled_at" IS NULL',
    ]) {
      expect(SQL_PARA_ANULAR).toContain(c);
    }
  });

  it('quién atendió mira sólo desde la reapertura o la encuesta anterior', () => {
    const sql = sqlDeQuienAtendio();
    expect(sql).toContain(`"system_code" IN ('reopened', 'csat_request')`);
    expect(sql.match(/"seq" > COALESCE/g)).toHaveLength(2);
    expect(sql).toContain(`"template_key" = 'asistente_ia'`);
  });
});

describe('BandejaEncuestaService: resumen (4b, lectura para B4)', () => {
  it('sólo de la empresa de quien pide y del período; sin período, los últimos 30 días', async () => {
    const t = armar();
    const r = await t.servicio.resumen(
      { ...cliente(), party: Party.COMPANY },
      {},
      AHORA,
    );
    const [sql, params] = t.consultas[0];
    expect(sql).toContain('"distributor_id" = $1');
    expect(params).toEqual([A, new Date('2026-10-16T15:00:00Z'), AHORA, AHORA]);
    expect(r).toMatchObject({ requested: 0, answered: 0, average: null });
  });

  it('las anuladas no son pedidas ni vencidas: se cuentan aparte', () => {
    expect(SQL_DEL_RESUMEN).toContain(
      'count(*) FILTER (WHERE "cancelled_at" IS NULL) AS n',
    );
    expect(SQL_DEL_RESUMEN).toMatch(
      /"answered_at" IS NULL AND "cancelled_at" IS NULL\s+AND "expires_at" < \$4\) AS vencidas/,
    );
    expect(SQL_DEL_RESUMEN).toContain(
      'count(*) FILTER (WHERE "cancelled_at" IS NOT NULL) AS anuladas',
    );
  });

  it('cuentas: pedidas, vencidas, promedio, CSAT (4 y 5) y por quién atendió', () => {
    const r = resumirEncuestas(
      [
        { served_by: 'assistant', score: 5, n: '3', vencidas: '0' },
        { served_by: 'assistant', score: 2, n: '1', vencidas: '0' },
        { served_by: 'team', score: 4, n: '2', vencidas: '0' },
        {
          served_by: 'team',
          score: null,
          n: '4',
          vencidas: '3',
          anuladas: '2',
        },
      ],
      new Date('2026-11-01T00:00:00Z'),
      AHORA,
    );
    expect(r).toEqual({
      from: new Date('2026-11-01T00:00:00Z'),
      to: AHORA,
      requested: 10,
      expired: 3,
      cancelled: 2,
      answered: 6,
      // (5·3 + 2 + 4·2) / 6
      average: 4.17,
      csat: 0.833,
      byScore: { '1': 0, '2': 1, '3': 0, '4': 2, '5': 3 },
      assistant: { answered: 4, average: 4.25, csat: 0.75 },
      team: { answered: 2, average: 4, csat: 1 },
    });
  });
});
