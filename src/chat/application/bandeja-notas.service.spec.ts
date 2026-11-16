import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource } from 'typeorm';
import {
  EVENTO_NOTIFICAR_ADMIN,
  NotificarAdminEvent,
} from '../../common/events/notificar-admin.event';
import {
  Channel,
  MessageKind,
  MessageVisibility,
  Party,
} from '../domain/chat.enums';
import {
  ConversacionNoEncontradaError,
  MencionNoPermitidaError,
} from '../domain/chat.errors';
import { Conversation } from '../entities/conversation.entity';
import { MessageMention } from '../entities/message-mention.entity';
import type { ActorDeLaBandeja, BandejaAcceso } from './bandeja-acceso';
import type { BandejaEquipoService } from './bandeja-equipo.service';
import {
  AVISO_DE_MENCION,
  BandejaNotasService,
  marcarMencionesLeidas,
} from './bandeja-notas.service';
import type { ChatEvents, Efectos } from './chat.events';
import type { ChatRateLimit } from './chat-rate-limit';
import type { MessageWriter } from './message-writer';
import type { NuevoMensaje } from './mensajes.port';

const A = 'dist-a';
const B = 'dist-b';
const CONV = 'conv-1';
const YO = 'adm-1';
const JUAN = 'adm-2';
const ANA = 'adm-3';
const DE_OTRA = 'adm-b';

const actor = (distributorId = A): ActorDeLaBandeja => ({
  party: Party.COMPANY,
  userId: YO,
  distributorId,
  canales: [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER],
  permisos: ['mensajes.clientes', 'mensajes.choferes'],
});

function armar(
  o: {
    creado?: boolean;
    /** Quiénes atienden el canal, por empresa. */
    equipo?: Record<string, string[]>;
  } = {},
) {
  const conversacion = Object.assign(new Conversation(), {
    conversationId: CONV,
    distributorId: A,
    channel: Channel.STAFF_CUSTOMER,
  });
  const acceso = {
    buscar: jest.fn((a: ActorDeLaBandeja) =>
      a.distributorId === A
        ? Promise.resolve(conversacion)
        : Promise.reject(new ConversacionNoEncontradaError()),
    ),
  };
  const porEmpresa = o.equipo ?? { [A]: [YO, JUAN, ANA], [B]: [DE_OTRA] };
  const equipo = {
    quienesAtienden: jest.fn((empresa: string) =>
      Promise.resolve(
        (porEmpresa[empresa] ?? []).map((userId) => ({ userId })),
      ),
    ),
  };
  const escritos: NuevoMensaje[] = [];
  const writer = {
    escribir: jest.fn((_m: unknown, nuevo: NuevoMensaje) => {
      escritos.push(nuevo);
      return Promise.resolve({
        message: { ...nuevo, messageId: 'nota-1', seq: 7 },
        created: o.creado ?? true,
        conversation: conversacion,
      });
    }),
  };
  const insertadas: unknown[] = [];
  const manager = {
    getRepository: jest.fn((entidad: unknown) => {
      expect(entidad).toBe(MessageMention);
      return {
        insert: jest.fn((filas: unknown) => {
          insertadas.push(filas);
          return Promise.resolve();
        }),
      };
    }),
  };
  const query = jest.fn(() => Promise.resolve([[{ mention_id: 'x' }], 1]));
  const dataSource = {
    transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
    query,
  };
  const cupos = { mensaje: jest.fn(() => Promise.resolve()) };
  const publicados: Efectos[] = [];
  const eventos = {
    publicar: jest.fn((e: Efectos) => publicados.push(e)),
  };
  const emit = jest.fn();
  const servicio = new BandejaNotasService(
    dataSource as unknown as DataSource,
    acceso as unknown as BandejaAcceso,
    equipo as unknown as BandejaEquipoService,
    writer as unknown as MessageWriter,
    cupos as unknown as ChatRateLimit,
    eventos as unknown as ChatEvents,
    { emit } as unknown as EventEmitter2,
  );
  return {
    servicio,
    conversacion,
    acceso,
    equipo,
    escritos,
    insertadas,
    cupos,
    publicados,
    emit,
    query,
  };
}

const nota = (mentions?: string[]) => ({
  clientMessageId: '0d6f0c34-8b7e-4c1a-9f3b-5a2e7d9c1b20',
  body: '@Juan fijate si el chofer pasó',
  ...(mentions ? { mentions } : {}),
});

describe('BandejaNotasService: notas internas con @menciones (4a)', () => {
  it('escribe una nota interna del personal (texto, visibilidad interna) y la publica', async () => {
    const t = armar();
    const r = await t.servicio.escribir(actor(), CONV, nota());
    expect(r.created).toBe(true);
    expect(t.escritos).toEqual([
      expect.objectContaining({
        conversationId: CONV,
        distributorId: A,
        senderParty: Party.COMPANY,
        senderUserId: YO,
        kind: MessageKind.TEXT,
        visibility: MessageVisibility.INTERNAL,
        body: '@Juan fijate si el chofer pasó',
      }),
    ]);
    expect(t.publicados[0].mensajes).toHaveLength(1);
    // Sin menciones: no hace falta mirar al equipo ni avisar a nadie.
    expect(t.equipo.quienesAtienden).not.toHaveBeenCalled();
    expect(t.insertadas).toEqual([]);
    expect(t.emit).not.toHaveBeenCalled();
    expect(t.cupos.mensaje).toHaveBeenCalledWith(
      expect.objectContaining({ ambito: A, userId: YO }),
    );
  });

  it('guarda las menciones y avisa a cada mencionado (no al autor) con un aviso sólo para él', async () => {
    const t = armar();
    await t.servicio.escribir(actor(), CONV, nota([JUAN, YO, ANA]));
    expect(t.equipo.quienesAtienden).toHaveBeenCalledWith(
      A,
      Channel.STAFF_CUSTOMER,
    );
    expect(t.insertadas).toEqual([
      [JUAN, YO, ANA].map((mentionedUserId) => ({
        messageId: 'nota-1',
        conversationId: CONV,
        distributorId: A,
        mentionedUserId,
        readAt: null,
      })),
    ]);
    const avisos = t.emit.mock.calls.map(
      ([nombre, e]: [string, NotificarAdminEvent]) => {
        expect(nombre).toBe(EVENTO_NOTIFICAR_ADMIN);
        return e;
      },
    );
    expect(avisos.map((e) => e.recipientUserId)).toEqual([JUAN, ANA]);
    expect(avisos[0]).toMatchObject({
      distributorId: A,
      kind: AVISO_DE_MENCION,
      title: 'Te mencionaron en una conversación con un cliente',
      body: '@Juan fijate si el chofer pasó',
      link: { entity: 'conversation', id: CONV },
      email: false,
      dedupeKey: `chat-mention:nota-1:${JUAN}`,
    });
  });

  it('mencionar a alguien que no atiende el canal: 400 MENTION_NOT_ALLOWED, sin escribir ni gastar cupo', async () => {
    const t = armar({ equipo: { [A]: [YO, JUAN] } });
    await expect(
      t.servicio.escribir(actor(), CONV, nota([JUAN, ANA])),
    ).rejects.toBeInstanceOf(MencionNoPermitidaError);
    expect(t.escritos).toEqual([]);
    expect(t.cupos.mensaje).not.toHaveBeenCalled();
    expect(t.emit).not.toHaveBeenCalled();
  });

  it('dos empresas: nadie de otra empresa se puede mencionar (el equipo es el de quien escribe)', async () => {
    const t = armar();
    await expect(
      t.servicio.escribir(actor(A), CONV, nota([DE_OTRA])),
    ).rejects.toBeInstanceOf(MencionNoPermitidaError);
    expect(t.equipo.quienesAtienden).toHaveBeenCalledWith(
      A,
      Channel.STAFF_CUSTOMER,
    );
  });

  it('dos empresas: una conversación de otra empresa es 404 y no se escribe nada', async () => {
    const t = armar();
    await expect(
      t.servicio.escribir(actor(B), CONV, nota([DE_OTRA])),
    ).rejects.toBeInstanceOf(ConversacionNoEncontradaError);
    expect(t.escritos).toEqual([]);
    expect(t.equipo.quienesAtienden).not.toHaveBeenCalled();
  });

  it('reintento con el mismo clientMessageId: la misma nota, sin volver a guardar menciones ni avisar', async () => {
    const t = armar({ creado: false });
    const r = await t.servicio.escribir(actor(), CONV, nota([JUAN]));
    expect(r.created).toBe(false);
    expect(t.insertadas).toEqual([]);
    expect(t.emit).not.toHaveBeenCalled();
    expect(t.publicados[0].mensajes).toEqual([]);
  });

  it('marcar leídas: sólo las de quien pide, en esa conversación y esa empresa; 404 si la conversación no es suya', async () => {
    const t = armar();
    expect(await t.servicio.marcarLeidas(actor(), CONV, 7)).toBe(1);
    const [sql, params] = t.query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(params).toEqual([CONV, YO, A, 7]);
    for (const condicion of [
      'mm."conversation_id" = $1',
      'mm."mentioned_user_id" = $2',
      'mm."distributor_id" = $3',
      'mm."read_at" IS NULL',
      'm."seq" <= $4',
    ]) {
      expect(sql).toContain(condicion);
    }
    await expect(
      t.servicio.marcarLeidas(actor(B), CONV),
    ).rejects.toBeInstanceOf(ConversacionNoEncontradaError);
  });

  it('marcarMencionesLeidas sin tope marca todas (hasta nulo) y cuenta las filas devueltas', async () => {
    const query = jest.fn(() =>
      Promise.resolve([[{ mention_id: 'a' }, { mention_id: 'b' }], 2]),
    );
    expect(await marcarMencionesLeidas({ query } as never, CONV, YO, A)).toBe(
      2,
    );
    expect((query.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual([
      CONV,
      YO,
      A,
      null,
    ]);
    expect(
      await marcarMencionesLeidas(
        { query: jest.fn(() => Promise.resolve([])) } as never,
        CONV,
        YO,
        A,
      ),
    ).toBe(0);
  });

  it('el aviso de una mención en una conversación con un chofer lo dice', async () => {
    const t = armar();
    t.conversacion.channel = Channel.STAFF_DRIVER;
    await t.servicio.escribir(actor(), CONV, nota([JUAN]));
    expect(
      (t.emit.mock.calls[0] as [string, NotificarAdminEvent])[1].title,
    ).toBe('Te mencionaron en una conversación con un chofer');
  });
});
