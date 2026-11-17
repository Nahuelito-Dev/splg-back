import type { DataSource, EntityManager } from 'typeorm';
import { auditContext } from '../../audit/data/audit-context';
import type { CanalDeLaBandeja } from '../domain/bandeja';
import { Channel, ConversationStatus } from '../domain/chat.enums';
import { Conversation } from '../entities/conversation.entity';
import type { AgentesDeLaBandeja } from '../infrastructure/agentes-de-la-bandeja';
import {
  AsignacionAutomaticaService,
  claveDelReparto,
  TIEMPO_DE_CERROJO_MS,
  TIEMPO_DE_SENTENCIA_MS,
  TOPE_DE_LA_VUELTA_MS,
  TOPE_DE_VUELTAS,
} from './asignacion-automatica.service';
import type { BandejaGestionService } from './bandeja-gestion.service';
import type { ChatEvents, Efectos } from './chat.events';
import {
  ajustesDeLaBandejaPorDefecto,
  type CompanyChatSettingsService,
} from './company-chat-settings.service';
import type {
  AgenteDeLaBandeja,
  EquipoDeLaBandejaService,
} from './equipo-de-la-bandeja.service';

const A = 'dist-a';
const T = new Date('2026-11-17T15:00:00Z');
const C3 = Channel.STAFF_CUSTOMER;
const C2 = Channel.STAFF_DRIVER;

const tic = () => new Promise<void>((r) => setImmediate(r));

interface Fila {
  conversationId: string;
  distributorId: string;
  channel: CanalDeLaBandeja;
  status: ConversationStatus;
  assignedToUserId: string | null;
  assignedAutomatically: boolean;
  awaitingHumanSince: Date | null;
  /** La última persona del equipo que le respondió. */
  preferido?: string | null;
}

type Agente = Partial<AgenteDeLaBandeja> & { userId: string };

/**
 * Una base en memoria con lo que importa del reparto, compartida por las
 * instancias del servicio que se creen (`instancia()`): las conversaciones,
 * el cerrojo de transacción que se INTENTA (`pg_try_advisory_xact_lock`, se
 * suelta al terminar la transacción), el `FOR UPDATE SKIP LOCKED` de la cola
 * y cuántas transacciones (conexiones) hay abiertas a la vez. El
 * `DataSource` sólo sabe abrir transacciones: cualquier consulta por fuera
 * del `manager` rompe. Cada paso cede el turno (`tic`) para que dos repartos
 * simultáneos se intercalen como en la base.
 */
function mundo(
  opciones: {
    filas?: Fila[];
    tope?: number;
    habilitada?: boolean;
    chat?: boolean;
    /** Se llama después de cada lectura de la cola (para que pase algo en el medio). */
    despuesDeLaCola?: (vez: number) => void;
    agentes?: Agente[];
    /** Cuántos turnos tarda cada asignación (para abrir la ventana de una carrera). */
    turnosPorAsignacion?: number;
  } = {},
) {
  const filas = new Map(
    (opciones.filas ?? []).map((f) => [f.conversationId, f]),
  );
  const cerrojos = new Set<string>();
  const tomadasPor = new Map<string, number>();
  const orden: string[] = [];
  const consultas: string[] = [];
  const marcadas: string[] = [];
  const conexion = { abiertas: 0, maximo: 0, total: 0 };
  let lecturasDeLaCola = 0;

  const dataSource = {
    transaction: jest.fn(async (fn: (m: EntityManager) => Promise<unknown>) => {
      const tx = ++conexion.total;
      conexion.abiertas += 1;
      conexion.maximo = Math.max(conexion.maximo, conexion.abiertas);
      orden.push('transacción');
      const propios: string[] = [];
      const manager = {
        query: jest.fn(async (sql: string, params: unknown[]) => {
          consultas.push(sql);
          await tic();
          if (sql.includes('pg_try_advisory_xact_lock')) {
            const clave = String(params[0]);
            if (cerrojos.has(clave)) return [{ ok: false }];
            cerrojos.add(clave);
            propios.push(clave);
            return [{ ok: true }];
          }
          return [];
        }),
        getRepository: () => ({
          findOneByOrFail: jest.fn(
            async ({ conversationId }: { conversationId: string }) => {
              await tic();
              return Object.assign(new Conversation(), {
                ...filas.get(conversationId),
              });
            },
          ),
        }),
        tx,
      } as unknown as EntityManager;
      try {
        return await fn(manager);
      } finally {
        for (const [id, duenio] of tomadasPor) {
          if (duenio === tx) tomadasPor.delete(id);
        }
        propios.forEach((c) => cerrojos.delete(c));
        conexion.abiertas -= 1;
      }
    }),
  } as unknown as DataSource;

  const ajustes = {
    chatDisponible: jest.fn(() => Promise.resolve(opciones.chat ?? true)),
    leer: jest.fn((d: string) =>
      Promise.resolve(
        Object.assign(ajustesDeLaBandejaPorDefecto(d), {
          autoAssignEnabled: opciones.habilitada ?? true,
          autoAssignMaxOpen: opciones.tope ?? 1,
        }),
      ),
    ),
  };

  const agentes = {
    cola: jest.fn(
      async (
        m: EntityManager & { tx: number },
        d: string,
        porCanal: ReadonlyMap<CanalDeLaBandeja, number>,
      ) => {
        await tic();
        const cola = [...porCanal].flatMap(([canal, limite]) =>
          [...filas.values()]
            .filter(
              (f) =>
                f.distributorId === d &&
                f.channel === canal &&
                f.status === ConversationStatus.OPEN &&
                f.assignedToUserId === null &&
                f.awaitingHumanSince !== null &&
                !tomadasPor.has(f.conversationId),
            )
            .sort(
              (x, y) =>
                (x.awaitingHumanSince as Date).getTime() -
                (y.awaitingHumanSince as Date).getTime(),
            )
            .slice(0, limite),
        );
        for (const f of cola) tomadasPor.set(f.conversationId, m.tx);
        opciones.despuesDeLaCola?.(++lecturasDeLaCola);
        return cola.map((f) => ({
          conversationId: f.conversationId,
          canal: f.channel,
          preferido: f.preferido ?? null,
        }));
      },
    ),
    marcarAsignacion: jest.fn(
      async (_m: EntityManager, _d: string, userId: string) => {
        await tic();
        marcadas.push(userId);
      },
    ),
  };

  const abiertasDe = (userId: string) =>
    [...filas.values()].filter(
      (f) =>
        f.assignedToUserId === userId && f.status === ConversationStatus.OPEN,
    ).length;

  const equipo = {
    conexionesDe: jest.fn(async () => {
      orden.push('presencia');
      await tic();
      return new Map();
    }),
    delaEmpresa: jest.fn(
      async (
        _d: string,
        _ahora: Date,
        o: { ajustes: { autoAssignMaxOpen: number } },
      ) => {
        await tic();
        return (opciones.agentes ?? [{ userId: 'ana' }]).map(
          (p): AgenteDeLaBandeja => ({
            name: p.userId,
            status: 'online',
            connected: true,
            available: true,
            maxOpen: o.ajustes.autoAssignMaxOpen,
            maxOpenOverride: null,
            channels: [C3, C2],
            lastAssignedAt: null,
            ...p,
            openAssigned: abiertasDe(p.userId),
          }),
        );
      },
    ),
    avisar: jest.fn(() => Promise.resolve()),
  };

  const gestion = {
    asignarDentro: jest.fn(
      async (
        _m: EntityManager,
        c: Conversation,
        userId: string,
        efectos: Efectos,
        automatica: boolean,
      ) => {
        for (let i = 0; i < (opciones.turnosPorAsignacion ?? 1); i++) {
          await tic();
        }
        const fila = filas.get(c.conversationId) as Fila;
        fila.assignedToUserId = userId;
        fila.assignedAutomatically = automatica;
        fila.awaitingHumanSince = null;
        efectos.conversacion(c, 'assigned', null);
        return c;
      },
    ),
  };
  const eventos = { publicar: jest.fn() };

  const instancia = () =>
    new AsignacionAutomaticaService(
      dataSource,
      ajustes as unknown as CompanyChatSettingsService,
      equipo as unknown as EquipoDeLaBandejaService,
      agentes as unknown as AgentesDeLaBandeja,
      gestion as unknown as BandejaGestionService,
      eventos as unknown as ChatEvents,
    );
  return {
    servicio: instancia(),
    instancia,
    dataSource,
    filas,
    marcadas,
    consultas,
    orden,
    conexion,
    gestion,
    eventos,
    equipo,
    agentes,
    abiertasDe,
  };
}

const esperando = (
  id: string,
  minutos: number,
  cambios: Partial<Fila> = {},
): Fila => ({
  conversationId: id,
  distributorId: A,
  channel: C3,
  status: ConversationStatus.OPEN,
  assignedToUserId: null,
  assignedAutomatically: false,
  awaitingHumanSince: new Date(T.getTime() - minutos * 60_000),
  ...cambios,
});

describe('AsignacionAutomaticaService (8b)', () => {
  it('reparte la más vieja primero, por el camino de la asignación a mano y marcada como automática', async () => {
    const m = mundo({
      tope: 1,
      filas: [esperando('nueva', 1), esperando('vieja', 30)],
    });
    const hechas = await m.servicio.repartir(A, T);
    expect(hechas).toEqual([{ conversationId: 'vieja', userId: 'ana' }]);
    expect(m.gestion.asignarDentro).toHaveBeenCalledTimes(1);
    expect(m.gestion.asignarDentro.mock.calls[0][4]).toBe(true);
    expect(m.filas.get('vieja')?.assignedAutomatically).toBe(true);
    expect(m.filas.get('nueva')?.assignedToUserId).toBeNull();
    expect(m.marcadas).toEqual(['ana']);
    // Los avisos de siempre (después del commit) y el tablero del equipo.
    expect(m.eventos.publicar).toHaveBeenCalledTimes(1);
    expect(m.equipo.avisar).toHaveBeenCalledWith(A, ['ana']);
  });

  it('una sola conexión: Redis antes de abrir la transacción, y adentro todo por su `manager` (el `DataSource` no consulta)', async () => {
    const m = mundo({ filas: [esperando('c1', 5)] });
    await m.servicio.repartir(A, T);
    expect(m.orden).toEqual(['presencia', 'transacción']);
    const [, , opciones] = m.equipo.delaEmpresa.mock.calls[0] as unknown as [
      string,
      Date,
      { manager: EntityManager & { tx: number }; conexiones: unknown },
    ];
    expect(opciones.manager.tx).toBe(1);
    expect(opciones.conexiones).toBeInstanceOf(Map);
    // El doble de `DataSource` sólo tiene `transaction`: si algo hubiera
    // consultado por fuera del `manager`, el reparto habría fallado.
    expect(Object.keys(m.dataSource)).toEqual(['transaction']);
    expect(m.filas.get('c1')?.assignedToUserId).toBe('ana');
  });

  it('con tope de tiempo a las sentencias y a la espera de cerrojos, e intenta el cerrojo de la empresa antes de leer nada', async () => {
    const m = mundo({ filas: [esperando('c1', 5)] });
    await m.servicio.repartir(A, T);
    expect(m.consultas.slice(0, 3)).toEqual([
      `SET LOCAL statement_timeout = '${TIEMPO_DE_SENTENCIA_MS}ms'`,
      `SET LOCAL lock_timeout = '${TIEMPO_DE_CERROJO_MS}ms'`,
      expect.stringContaining('pg_try_advisory_xact_lock') as unknown,
    ]);
    expect(claveDelReparto(A)).toBe(`chat:auto-assign:${A}`);
  });

  it('apagada o sin el módulo `chat`: nada (ni transacción)', async () => {
    const apagada = mundo({ habilitada: false, filas: [esperando('c1', 5)] });
    expect(await apagada.servicio.repartir(A, T)).toEqual([]);
    expect(apagada.agentes.cola).not.toHaveBeenCalled();
    expect(apagada.conexion.total).toBe(0);
    const sinModulo = mundo({ chat: false, filas: [esperando('c1', 5)] });
    expect(await sinModulo.servicio.repartir(A, T)).toEqual([]);
    expect(sinModulo.conexion.total).toBe(0);
  });

  it('la cola sólo pide los canales con lugar y cuántas: nadie con lugar, ni se lee', async () => {
    const m = mundo({
      tope: 1,
      agentes: [{ userId: 'beto', channels: [C2] }],
      filas: [esperando('c3', 30), esperando('c2', 5, { channel: C2 })],
    });
    await m.servicio.repartir(A, T);
    const porCanal = m.agentes.cola.mock.calls[0][2];
    expect([...porCanal]).toEqual([[C2, 1]]);
    expect(m.filas.get('c2')?.assignedToUserId).toBe('beto');
    // La de clientes ni se tocó (ni se bloqueó).
    expect(m.filas.get('c3')?.assignedToUserId).toBeNull();

    const lleno = mundo({
      tope: 1,
      filas: [
        esperando('c1', 5),
        esperando('ya', 60, {
          assignedToUserId: 'ana',
          awaitingHumanSince: null,
        }),
      ],
    });
    expect(await lleno.servicio.repartir(A, T)).toEqual([]);
    expect(lleno.agentes.cola).not.toHaveBeenCalled();
  });

  it('si alguien del equipo ya le respondió, vuelve a esa persona (aunque otro tenga más lugar); si no puede, reparto normal', async () => {
    const m = mundo({
      tope: 5,
      agentes: [{ userId: 'ana' }, { userId: 'beto', maxOpen: 1 }],
      filas: [esperando('c1', 5, { preferido: 'beto' })],
    });
    await m.servicio.repartir(A, T);
    expect(m.filas.get('c1')?.assignedToUserId).toBe('beto');

    const ausente = mundo({
      tope: 5,
      agentes: [{ userId: 'ana' }, { userId: 'beto', available: false }],
      filas: [esperando('c1', 5, { preferido: 'beto' })],
    });
    await ausente.servicio.repartir(A, T);
    expect(ausente.filas.get('c1')?.assignedToUserId).toBe('ana');
  });

  it('una que alguien tomó entre la cola y la asignación no se pisa', async () => {
    const m = mundo({ tope: 5, filas: [esperando('c1', 5)] });
    m.agentes.cola.mockImplementationOnce(async () => {
      await tic();
      (m.filas.get('c1') as Fila).assignedToUserId = 'beto';
      return [{ conversationId: 'c1', canal: C3, preferido: null }];
    });
    expect(await m.servicio.repartir(A, T)).toEqual([]);
    expect(m.gestion.asignarDentro).not.toHaveBeenCalled();
    expect(m.filas.get('c1')?.assignedToUserId).toBe('beto');
  });

  it('corre como «sistema»: sin el usuario del request que lo disparó', async () => {
    const m = mundo({ filas: [esperando('c1', 5)] });
    let visto: unknown = 'sin mirar';
    m.agentes.cola.mockImplementationOnce(() => {
      visto = auditContext.getStore();
      return Promise.resolve([]);
    });
    await auditContext.run(
      { userId: 'cliente-1', ip: null, distributorId: A },
      () => m.servicio.repartir(A, T),
    );
    expect(visto).toBeUndefined();
  });

  it('un repartidor por empresa: muchos disparos a la vez no abren más de una transacción, y lo que llegó en el medio entra en una vuelta más', async () => {
    const c2 = esperando('c2', 0, { awaitingHumanSince: null });
    let disparos: Array<Promise<unknown>> = [];
    const m = mundo({
      tope: 5,
      filas: [esperando('c1', 10), c2],
      despuesDeLaCola: (vez) => {
        if (vez !== 1) return;
        c2.awaitingHumanSince = T;
        disparos = Array.from({ length: 10 }, () => m.servicio.repartir(A, T));
      },
    });
    const primero = await m.servicio.repartir(A, T);
    const otros = await Promise.all(disparos);
    expect(m.conexion.maximo).toBe(1);
    expect(m.conexion.total).toBe(2);
    expect(m.filas.get('c2')?.assignedToUserId).toBe('ana');
    // Todos esperan la misma corrida.
    for (const r of otros) expect(r).toBe(otros[0]);
    expect(primero).toEqual([
      { conversationId: 'c1', userId: 'ana' },
      { conversationId: 'c2', userId: 'ana' },
    ]);
  });

  it('entre instancias: si otra está repartiendo la empresa, no espera el cerrojo ni le pasa el tope a nadie', async () => {
    // Ana tiene tope 1. Cuando la instancia 1 ya leyó la cola (y tomó c1),
    // llega c2 y la instancia 2 dispara su reparto.
    let segunda: Promise<unknown> = Promise.resolve();
    const c2 = esperando('c2', 0, { awaitingHumanSince: null });
    const m = mundo({
      tope: 1,
      filas: [esperando('c1', 10), c2],
      // La primera tarda en asignar: la segunda lee la carga en el medio.
      turnosPorAsignacion: 20,
      despuesDeLaCola: (vez) => {
        if (vez !== 1) return;
        c2.awaitingHumanSince = T;
        segunda = m.instancia().repartir(A, T);
      },
    });
    await m.servicio.repartir(A, T);
    expect(await segunda).toEqual([]);
    expect(m.abiertasDe('ana')).toBe(1);
    expect(m.filas.get('c1')?.assignedToUserId).toBe('ana');
    expect(m.filas.get('c2')?.assignedToUserId).toBeNull();
    const asignadas = m.gestion.asignarDentro.mock.calls.map(
      (c) => c[1].conversationId,
    );
    expect(asignadas).toEqual(['c1']);
  });

  it('repartirSinFallar: un error queda en el log y devuelve nada; el siguiente disparo vuelve a correr', async () => {
    const m = mundo({ filas: [esperando('c1', 5)] });
    m.agentes.cola.mockRejectedValueOnce(new Error('se cayó la base'));
    await expect(m.servicio.repartirSinFallar(A, T)).resolves.toEqual([]);
    expect(await m.servicio.repartir(A, T)).toEqual([
      { conversationId: 'c1', userId: 'ana' },
    ]);
  });

  it('una vuelta colgada no traba a la empresa: a los 30 s se abandona (queda en el log) y el próximo disparo arranca otra corrida', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const m = mundo({ filas: [esperando('c1', 5)] });
      m.agentes.cola.mockImplementationOnce(() => new Promise(() => {}));
      const colgada = m.servicio.repartirSinFallar(A, T);
      // Mientras tanto, otro disparo se suma a esa misma corrida.
      const sumado = m.servicio.repartirSinFallar(A, T);
      await jest.advanceTimersByTimeAsync(TOPE_DE_LA_VUELTA_MS);
      await expect(colgada).resolves.toEqual([]);
      await expect(sumado).resolves.toEqual([]);
      expect(m.conexion.total).toBe(1);
      // La empresa quedó libre: un disparo nuevo abre otra transacción.
      void m.servicio.repartirSinFallar(A, T);
      await jest.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 20 && m.conexion.total < 2; i++) {
        await new Promise<void>((r) => setImmediate(r));
      }
      expect(m.conexion.total).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('una corrida da como mucho TOPE_DE_VUELTAS vueltas aunque sigan llegando disparos (lo demás, la próxima)', async () => {
    let n = 0;
    const m = mundo({
      tope: 50,
      filas: [esperando('c0', 5)],
      despuesDeLaCola: () => {
        n += 1;
        m.filas.set(`n${n}`, esperando(`n${n}`, 0));
        void m.servicio.repartir(A, T);
      },
    });
    await m.servicio.repartir(A, T);
    expect(m.conexion.total).toBe(TOPE_DE_VUELTAS);
    // La que llegó en la última vuelta quedó esperando para el próximo disparo.
    expect(m.filas.get(`n${n}`)?.assignedToUserId).toBeNull();
  });

  it('disparar no espera el reparto (la request responde aunque el reparto no termine)', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const m = mundo({ filas: [esperando('c1', 5)] });
      m.agentes.cola.mockImplementationOnce(() => new Promise(() => {}));
      expect(m.servicio.disparar(A)).toBeUndefined();
      // Que el abandono de la vuelta no deje un temporizador vivo.
      await jest.advanceTimersByTimeAsync(TOPE_DE_LA_VUELTA_MS);
    } finally {
      jest.useRealTimers();
    }
  });
});
