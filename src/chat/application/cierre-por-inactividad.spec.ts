import type { DataSource, EntityManager } from 'typeorm';
import {
  dentroDeCorrida,
  nuevaCorrida,
} from '../../process-run/process-run.context';
import type { RedisService } from '../../redis/redis.service';
import {
  Channel,
  ConversationClosedReason,
  ConversationStatus,
  MessageKind,
  Party,
  SystemCode,
} from '../domain/chat.enums';
import type { ChatCompanySettings } from '../entities/chat-company-settings.entity';
import { Conversation } from '../entities/conversation.entity';
import {
  type BandejaGestionService,
  idDelMensajeDelLote,
  VERSION_DEL_ID_DEL_LOTE,
} from './bandeja-gestion.service';
import type { ChatEvents, Efectos } from './chat.events';
import {
  CierrePorInactividad,
  parametrosDelEstado,
  SQL_CANDIDATAS_POR_INACTIVIDAD,
  SQL_ESTADO_DE_INACTIVIDAD,
  TOPE_DE_CANDIDATAS,
} from './cierre-por-inactividad';
import { CierrePorInactividadCron } from './cierre-por-inactividad.cron';
import {
  ajustesDeLaBandejaPorDefecto,
  type CompanyChatSettingsService,
} from './company-chat-settings.service';
import type { MessageWriter } from './message-writer';

// Reloj fijo: nada de `Date.now()` suelto. Lunes 16/11/2026, 12 en Argentina.
const AHORA = new Date('2026-11-16T15:00:00Z');
const haceMin = (n: number) => new Date(AHORA.getTime() - n * 60_000);
// Lunes a viernes de 8 a 18 (Argentina).
const HORARIO_HABIL = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  opensAt: '08:00',
  closesAt: '18:00',
}));

interface FilaDelEstado {
  sender_party: Party | null;
  ultimo_at: Date | null;
  reabierta_at?: Date | null;
  aviso_at?: Date | null;
  aviso_cierra?: string | null;
}

interface Escenario {
  status?: ConversationStatus;
  canal?: Channel;
  esperandoPersona?: boolean;
  fila?: FilaDelEstado;
  ajustes?: Partial<ChatCompanySettings>;
  chatDisponible?: boolean;
  prendidas?: ChatCompanySettings[];
  candidatas?: Array<{ id: string; empresa: string }>;
}

function armar(e: Escenario) {
  const c = Object.assign(new Conversation(), {
    conversationId: 'conv-1',
    distributorId: 'empresa-a',
    channel: e.canal ?? Channel.STAFF_CUSTOMER,
    status: e.status ?? ConversationStatus.OPEN,
    awaitingHumanSince: e.esperandoPersona ? haceMin(5) : null,
  });
  const manager = {
    getRepository: jest.fn(() => ({
      findOne: jest.fn(() => Promise.resolve(c)),
    })),
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql === SQL_ESTADO_DE_INACTIVIDAD && e.fila ? [e.fila] : [],
      ),
    ),
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager as unknown as EntityManager),
    ),
    query: jest.fn(() => Promise.resolve(e.candidatas ?? [])),
    getRepository: jest.fn(() => ({
      find: jest.fn(() => Promise.resolve(e.prendidas ?? [])),
    })),
  };
  const ajustes = {
    leer: jest.fn(() =>
      Promise.resolve(
        Object.assign(ajustesDeLaBandejaPorDefecto('empresa-a'), {
          inactivityCloseMinutes: 60,
          inactivityWarningMinutes: 15,
          inactivityEnabledAt: haceMin(100_000),
          ...e.ajustes,
        }),
      ),
    ),
    chatDisponible: jest.fn((id: string) =>
      Promise.resolve(e.chatDisponible ?? id !== 'sin-modulo'),
    ),
  };
  const gestion = {
    cerrarDentro: jest.fn(() => Promise.resolve(c)),
  };
  const writer = {
    escribir: jest.fn((_m: EntityManager, nuevo: { body: string }) =>
      Promise.resolve({
        conversation: c,
        message: { ...nuevo, messageId: 'aviso' },
        created: true,
      }),
    ),
  };
  const publicados: Efectos[] = [];
  const eventos = { publicar: jest.fn((x: Efectos) => publicados.push(x)) };
  const servicio = new CierrePorInactividad(
    dataSource as unknown as DataSource,
    ajustes as unknown as CompanyChatSettingsService,
    gestion as unknown as BandejaGestionService,
    writer as unknown as MessageWriter,
    eventos as unknown as ChatEvents,
  );
  return {
    servicio,
    gestion,
    writer,
    publicados,
    manager,
    dataSource,
    ajustes,
  };
}

const delEquipo = (minutos: number, extra: Partial<FilaDelEstado> = {}) => ({
  sender_party: Party.COMPANY,
  ultimo_at: haceMin(minutos),
  ...extra,
});

describe('CierrePorInactividad: cada conversación, bloqueada y con reloj fijo (7c)', () => {
  it('última respuesta del equipo hace 50 min (cierre 60, aviso 15): avisa «cerramos en 15 min»', async () => {
    const { servicio, writer, gestion, publicados } = armar({
      fila: delEquipo(50),
    });
    expect(await servicio.procesar('conv-1', AHORA)).toBe('warned');
    expect(writer.escribir).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        senderParty: Party.SYSTEM,
        kind: MessageKind.SYSTEM,
        systemCode: SystemCode.INACTIVITY_WARNING,
        body: 'Si no tenés más consultas, cerramos la conversación en 15 min.',
        payload: {
          minutes: 15,
          closesAt: new Date(AHORA.getTime() + 15 * 60_000).toISOString(),
        },
      }),
    );
    expect(gestion.cerrarDentro).not.toHaveBeenCalled();
    expect(publicados[0].mensajes).toHaveLength(1);
  });

  it('respuesta del asistente, avisada en el ciclo y vencida: cierra por inactividad (con la encuesta del cierre)', async () => {
    const { servicio, gestion, writer } = armar({
      fila: {
        sender_party: Party.SYSTEM,
        ultimo_at: haceMin(70),
        aviso_at: haceMin(20),
        aviso_cierra: haceMin(5).toISOString(),
      },
    });
    expect(await servicio.procesar('conv-1', AHORA)).toBe('closed');
    expect(gestion.cerrarDentro).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'conv-1' }),
      ConversationClosedReason.INACTIVITY,
      null,
      expect.anything(),
      AHORA,
    );
    expect(writer.escribir).not.toHaveBeenCalled();
  });

  it('no cierra antes del cierre que se le mostró en el aviso', async () => {
    const { servicio, gestion } = armar({
      fila: delEquipo(70, {
        aviso_at: haceMin(10),
        aviso_cierra: new Date(AHORA.getTime() + 5 * 60_000).toISOString(),
      }),
    });
    expect(await servicio.procesar('conv-1', AHORA)).toBeNull();
    expect(gestion.cerrarDentro).not.toHaveBeenCalled();
  });

  it('reabierta hace 5 minutos (el último del equipo es de hace días): no avisa ni cierra', async () => {
    const { servicio, gestion, writer } = armar({
      fila: delEquipo(5_000, {
        reabierta_at: haceMin(5),
        aviso_at: haceMin(4_900),
        aviso_cierra: haceMin(4_885).toISOString(),
      }),
    });
    expect(await servicio.procesar('conv-1', AHORA)).toBeNull();
    expect(gestion.cerrarDentro).not.toHaveBeenCalled();
    expect(writer.escribir).not.toHaveBeenCalled();
  });

  it('reabierta hace 50 minutos: avisa de nuevo (el aviso viejo es de otro ciclo)', async () => {
    const { servicio } = armar({
      fila: delEquipo(5_000, {
        reabierta_at: haceMin(50),
        aviso_at: haceMin(4_900),
        aviso_cierra: haceMin(4_885).toISOString(),
      }),
    });
    expect(await servicio.procesar('conv-1', AHORA)).toBe('warned');
  });

  it('recién prendido: lo anterior no cuenta', async () => {
    const { servicio, writer } = armar({
      fila: delEquipo(5_000),
      ajustes: { inactivityEnabledAt: haceMin(10) },
    });
    expect(await servicio.procesar('conv-1', AHORA)).toBeNull();
    expect(writer.escribir).not.toHaveBeenCalled();
  });

  it('nunca cierra si el último mensaje es del cliente, aunque pasen días', async () => {
    const { servicio, gestion, writer } = armar({
      fila: { sender_party: Party.CUSTOMER, ultimo_at: haceMin(10_000) },
    });
    expect(await servicio.procesar('conv-1', AHORA)).toBeNull();
    expect(gestion.cerrarDentro).not.toHaveBeenCalled();
    expect(writer.escribir).not.toHaveBeenCalled();
  });

  it('nada si espera a una persona, si ya se cerró, si se apagó, fuera de horario, sin el módulo o con el chat de clientes apagado', async () => {
    const fila = delEquipo(10_000);
    for (const e of [
      { fila, esperandoPersona: true },
      { fila, status: ConversationStatus.CLOSED },
      {
        fila,
        ajustes: {
          inactivityCloseMinutes: null,
          inactivityWarningMinutes: null,
          inactivityEnabledAt: null,
        },
      },
      // Domingo: fuera del horario (lo hace cuando abre).
      {
        fila,
        ajustes: {
          businessHours: [{ weekday: 0, opensAt: '08:00', closesAt: '09:00' }],
        },
      },
      { fila, chatDisponible: false },
      { fila, ajustes: { customerChatEnabled: false } },
    ] as Escenario[]) {
      const { servicio, gestion, writer } = armar(e);
      expect(await servicio.procesar('conv-1', AHORA)).toBeNull();
      expect(gestion.cerrarDentro).not.toHaveBeenCalled();
      expect(writer.escribir).not.toHaveBeenCalled();
    }
  });

  it('con el chat de clientes apagado, las de choferes siguen', async () => {
    const { servicio } = armar({
      canal: Channel.STAFF_DRIVER,
      fila: delEquipo(50),
      ajustes: { customerChatEnabled: false },
    });
    expect(await servicio.procesar('conv-1', AHORA)).toBe('warned');
  });

  it('sin aviso configurado: cierra directo al pasar el plazo', async () => {
    const { servicio, gestion } = armar({
      fila: delEquipo(60),
      ajustes: { inactivityWarningMinutes: null },
    });
    expect(await servicio.procesar('conv-1', AHORA)).toBe('closed');
    expect(gestion.cerrarDentro).toHaveBeenCalledTimes(1);
  });

  it('un aviso guardado sin el cierre que mostró no vale (se vuelve a avisar)', async () => {
    const { servicio } = armar({
      fila: delEquipo(50, { aviso_at: haceMin(1), aviso_cierra: null }),
    });
    expect(await servicio.procesar('conv-1', AHORA)).toBe('warned');
  });
});

describe('CierrePorInactividad: candidatas', () => {
  const prendida = (
    distributorId: string,
    extra: Partial<ChatCompanySettings> = {},
  ) =>
    Object.assign(ajustesDeLaBandejaPorDefecto(distributorId), {
      inactivityCloseMinutes: 60,
      inactivityEnabledAt: haceMin(1_000),
      businessHours: HORARIO_HABIL,
      ...extra,
    });

  it('sólo las empresas en horario y con el módulo; los clientes, con su chat prendido; con el tope por corrida', async () => {
    const { servicio, dataSource } = armar({
      prendidas: [
        prendida('a'),
        prendida('sin-clientes', { customerChatEnabled: false }),
        prendida('cerrada', {
          businessHours: [{ weekday: 0, opensAt: '08:00', closesAt: '09:00' }],
        }),
        prendida('sin-modulo'),
      ],
    });
    await servicio.candidatas(AHORA);
    expect(dataSource.query).toHaveBeenCalledWith(
      SQL_CANDIDATAS_POR_INACTIVIDAD,
      [
        AHORA,
        'asistente_ia',
        'reopened',
        'inactivity_warning',
        VERSION_DEL_ID_DEL_LOTE,
        ['a'],
        ['a', 'sin-clientes'],
        TOPE_DE_CANDIDATAS,
      ],
    );
    expect(TOPE_DE_CANDIDATAS).toBe(200);
  });

  it('si ninguna empresa puede, ni consulta', async () => {
    const { servicio, dataSource } = armar({ prendidas: [] });
    expect(await servicio.candidatas(AHORA)).toEqual([]);
    expect(dataSource.query).not.toHaveBeenCalled();
  });
});

describe('las consultas del cierre por inactividad (sólo por el texto: se validan en vivo)', () => {
  it('candidatas: bandeja, abiertas, sin esperar persona, empresas vigentes y por canal, la pelota del lado del equipo, vencidas primero y con tope', () => {
    const sql = SQL_CANDIDATAS_POR_INACTIVIDAD;
    expect(sql).toContain(
      `(c."channel" = 'staff_customer' AND c."distributor_id" = ANY($6::uuid[]))`,
    );
    expect(sql).toContain(
      `(c."channel" = 'staff_driver' AND c."distributor_id" = ANY($7::uuid[]))`,
    );
    expect(sql).toContain(`c."status" = 'open'`);
    expect(sql).toContain('c."awaiting_human_since" IS NULL');
    expect(sql).toContain('d."deletedAt" IS NULL');
    expect(sql).toContain(`u."sender_party" IN ('company', 'system')`);
    expect(sql).toContain('m."distributor_id" = c."distributor_id"');
    // El ciclo: último que cuenta, alta de los plazos y reapertura.
    expect(sql).toContain('GREATEST(u."created_at", s."inactivity_enabled_at"');
    expect(sql).toContain('r."system_code" = $3');
    // El aviso, sólo del ciclo vigente.
    expect(sql).toContain('a."created_at" >= ini."inicio"');
    expect(sql).toContain('ORDER BY v."vence", x."id"');
    expect(sql).toContain('LIMIT $8');
  });

  it('cuentan las personas y las respuestas del asistente con IA; no los avisos, la respuesta fuera de horario ni los masivos a choferes', () => {
    for (const sql of [
      SQL_CANDIDATAS_POR_INACTIVIDAD,
      SQL_ESTADO_DE_INACTIVIDAD,
    ]) {
      expect(sql).toContain(`m."visibility" = 'all'`);
      expect(sql).toContain(`m."kind" IN ('text', 'attachment')`);
      expect(sql).toContain('m."template_key" = $2');
      expect(sql).toContain(
        'substring(m."client_message_id"::text from 15 for 1) = $5',
      );
      // Nada interpolado: los valores van por parámetro.
      expect(sql).not.toContain('${');
    }
    expect(parametrosDelEstado('conv-1')).toEqual([
      'conv-1',
      'asistente_ia',
      'reopened',
      'inactivity_warning',
      '5',
    ]);
  });

  it('el id de un mensaje masivo es de la versión que la consulta excluye; los de las apps y el panel (v4), no', () => {
    const id = idDelMensajeDelLote(
      '0d6f0c34-8b7e-4c1a-9f3b-5a2e7d9c1b20',
      'cho-1',
    );
    expect(id.charAt(14)).toBe(VERSION_DEL_ID_DEL_LOTE);
    expect('0d6f0c34-8b7e-4c1a-9f3b-5a2e7d9c1b20'.charAt(14)).toBe('4');
  });
});

describe('CierrePorInactividadCron (7c)', () => {
  it('recorre las candidatas: cuenta avisos y cierres, y una que falla no frena a las demás', async () => {
    const cierre = {
      candidatas: jest.fn(() =>
        Promise.resolve([
          { id: 'a-1', empresa: 'empresa-a' },
          { id: 'a-roto', empresa: 'empresa-a' },
          { id: 'b-1', empresa: 'empresa-b' },
          { id: 'b-2', empresa: 'empresa-b' },
        ]),
      ),
      procesar: jest.fn((id: string) =>
        id === 'a-roto'
          ? Promise.reject(new Error('se rompió la de A'))
          : Promise.resolve(
              id === 'a-1' ? 'warned' : id === 'b-1' ? 'closed' : null,
            ),
      ),
    };
    const cron = new CierrePorInactividadCron(
      {} as RedisService,
      cierre as unknown as CierrePorInactividad,
    );
    const corrida = nuevaCorrida();
    const r = await dentroDeCorrida(corrida, () => cron.barrer(AHORA, () => 0));
    expect(r).toEqual({ warned: 1, closed: 1, pending: 0 });
    expect(cierre.procesar.mock.calls).toEqual([
      ['a-1', AHORA],
      ['a-roto', AHORA],
      ['b-1', AHORA],
      ['b-2', AHORA],
    ]);
    expect(corrida).toMatchObject({ errors: 1, fatal: null });
    expect([...corrida.elementos.fallidos.keys()]).toEqual([
      'conversacion:a-roto',
    ]);
  });

  it('corta antes de que venza el cerrojo: lo que queda va a la próxima', async () => {
    const cierre = {
      candidatas: jest.fn(() =>
        Promise.resolve([
          { id: 'c-1', empresa: 'a' },
          { id: 'c-2', empresa: 'a' },
          { id: 'c-3', empresa: 'a' },
        ]),
      ),
      procesar: jest.fn(() => Promise.resolve('closed')),
    };
    // Cada lectura del reloj avanza dos minutos.
    let t = 0;
    const reloj = () => {
      const ahora = t;
      t += 2 * 60_000;
      return ahora;
    };
    const cron = new CierrePorInactividadCron(
      {} as RedisService,
      cierre as unknown as CierrePorInactividad,
    );
    const r = await cron.barrer(AHORA, reloj);
    expect(r).toEqual({ warned: 0, closed: 1, pending: 2 });
    expect(CierrePorInactividadCron.PRESUPUESTO_MS).toBeLessThan(
      CierrePorInactividadCron.CERROJO_TTL_MS,
    );
  });

  it('con el cerrojo tomado por otra instancia, la corrida queda saltada', async () => {
    const redis = {
      withLock: jest.fn(() => Promise.resolve({ obtenido: false })),
    };
    const cron = new CierrePorInactividadCron(
      redis as unknown as RedisService,
      { candidatas: jest.fn() } as unknown as CierrePorInactividad,
    );
    const corrida = nuevaCorrida();
    expect(await dentroDeCorrida(corrida, () => cron.cerrar())).toBeUndefined();
    expect(corrida.skipped).toBe(true);
    expect(redis.withLock).toHaveBeenCalledWith(
      'cron:chat-inactivity-close',
      240_000,
      expect.any(Function),
    );
  });

  it('con el cerrojo: corre el barrido y devuelve su resultado; si todo falla, error fatal en la corrida', async () => {
    const cierre = { candidatas: jest.fn(() => Promise.resolve([])) };
    const ok = new CierrePorInactividadCron(
      {
        withLock: jest.fn(
          (_k: string, _t: number, fn: () => Promise<unknown>) =>
            fn().then((valor) => ({ obtenido: true, valor })),
        ),
      } as unknown as RedisService,
      cierre as unknown as CierrePorInactividad,
    );
    expect(await ok.cerrar()).toEqual({ warned: 0, closed: 0, pending: 0 });

    const roto = new CierrePorInactividadCron(
      {
        withLock: jest.fn(() => Promise.reject(new Error('sin Redis'))),
      } as unknown as RedisService,
      cierre as unknown as CierrePorInactividad,
    );
    const corrida = nuevaCorrida();
    expect(await dentroDeCorrida(corrida, () => roto.cerrar())).toBeUndefined();
    expect(corrida.fatal).not.toBeNull();
  });
});
