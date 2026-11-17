import type { DataSource, EntityManager } from 'typeorm';
import type { AdminGateway } from '../../gateways/admin.gateway';
import { Channel } from '../domain/chat.enums';
import type {
  AgentesDeLaBandeja,
  AjustesDelAgente,
} from '../infrastructure/agentes-de-la-bandeja';
import {
  BandejaReadModel,
  type PersonaDelPersonal,
} from '../infrastructure/bandeja-read-model';
import type {
  ConexionDeLaPersona,
  PresenciaDeLaBandeja,
} from '../infrastructure/presencia-de-la-bandeja';
import {
  ajustesDeLaBandejaPorDefecto,
  type CompanyChatSettingsService,
} from './company-chat-settings.service';
import {
  comoCandidato,
  EquipoDeLaBandejaService,
  ESPERA_DE_LA_PRESENCIA_MS,
  EVENTO_SOCKET_EQUIPO,
} from './equipo-de-la-bandeja.service';

const A = 'dist-a';
// Martes 17/11/2026, 12:00 en Buenos Aires.
const AHORA = new Date('2026-11-17T15:00:00Z');

const persona = (
  userId: string,
  permisos: string[],
  todos = false,
): PersonaDelPersonal => ({
  userId,
  fullName: userId.toUpperCase(),
  photoKey: null,
  todos,
  permisos,
});

function armar(
  opciones: {
    personal?: PersonaDelPersonal[];
    guardados?: Array<[string, Partial<AjustesDelAgente>]>;
    abiertas?: Array<[string, number]>;
    conexiones?: Array<[string, ConexionDeLaPersona]>;
    presenciaRota?: boolean;
    tope?: number;
    franjas?: unknown[];
    yaAvisado?: Set<string>;
  } = {},
) {
  const lectura = {
    personalDeLaEmpresa: jest.fn(() =>
      Promise.resolve(opciones.personal ?? []),
    ),
  };
  const agentes = {
    ajustes: jest.fn(() =>
      Promise.resolve(
        new Map(
          (opciones.guardados ?? []).map(([u, g]) => [
            u,
            {
              status: 'away',
              statusChangedAt: AHORA,
              maxOpenOverride: null,
              lastAssignedAt: null,
              ...g,
            },
          ]),
        ),
      ),
    ),
    abiertasPorPersona: jest.fn(() =>
      Promise.resolve(new Map(opciones.abiertas ?? [])),
    ),
  };
  const avisados = opciones.yaAvisado ?? new Set<string>();
  const presencia = {
    deLaEmpresa: jest.fn(() =>
      opciones.presenciaRota
        ? Promise.reject(new Error('sin Redis'))
        : Promise.resolve(new Map(opciones.conexiones ?? [])),
    ),
    cambioElEstado: jest.fn((_d: string, u: string, estado: string) => {
      const clave = `${u}:${estado}`;
      const cambio = !avisados.has(clave);
      avisados.add(clave);
      return Promise.resolve(cambio);
    }),
  };
  const ajustes = {
    leer: jest.fn((d: string) =>
      Promise.resolve(
        Object.assign(ajustesDeLaBandejaPorDefecto(d), {
          autoAssignMaxOpen: opciones.tope ?? 5,
          businessHours: opciones.franjas ?? [],
        }),
      ),
    ),
  };
  const panel = { emitirAlEquipoDeLaBandeja: jest.fn() };
  const servicio = new EquipoDeLaBandejaService(
    { manager: {} } as unknown as DataSource,
    lectura as unknown as BandejaReadModel,
    agentes as unknown as AgentesDeLaBandeja,
    presencia as unknown as PresenciaDeLaBandeja,
    ajustes as unknown as CompanyChatSettingsService,
    panel as unknown as AdminGateway,
  );
  return { servicio, panel, presencia, agentes, ajustes };
}

const conectada: ConexionDeLaPersona = {
  conectado: true,
  vistoEn: AHORA.getTime(),
};

describe('EquipoDeLaBandejaService (8b)', () => {
  it('el equipo: sólo quien atiende algún canal, con sus canales; el rol de sistema, los dos', async () => {
    const { servicio } = armar({
      personal: [
        persona('ana', ['mensajes.clientes']),
        persona('beto', ['pedidos.ver']),
        persona('caro', [], true),
        persona('dani', ['mensajes.choferes', 'mensajes.supervisar']),
      ],
    });
    const equipo = await servicio.delaEmpresa(A, AHORA);
    expect(equipo.map((a) => [a.userId, a.channels])).toEqual([
      ['ana', [Channel.STAFF_CUSTOMER]],
      ['caro', [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER]],
      ['dani', [Channel.STAFF_DRIVER]],
    ]);
  });

  it('sin elegir nunca: ausente, con el tope de la empresa y sin abiertas', async () => {
    const { servicio } = armar({
      personal: [persona('ana', ['mensajes.clientes'])],
      conexiones: [['ana', conectada]],
      tope: 7,
    });
    const [ana] = await servicio.delaEmpresa(A, AHORA);
    expect(ana).toMatchObject({
      status: 'away',
      connected: true,
      available: false,
      maxOpen: 7,
      maxOpenOverride: null,
      openAssigned: 0,
      lastAssignedAt: null,
    });
  });

  it('en línea, conectada y en horario: disponible, con su tope propio y su carga', async () => {
    const { servicio } = armar({
      personal: [persona('ana', ['mensajes.clientes'])],
      guardados: [['ana', { status: 'online', maxOpenOverride: 12 }]],
      abiertas: [['ana', 3]],
      conexiones: [['ana', conectada]],
    });
    const [ana] = await servicio.delaEmpresa(A, AHORA);
    expect(ana).toMatchObject({
      status: 'online',
      available: true,
      maxOpen: 12,
      maxOpenOverride: 12,
      openAssigned: 3,
    });
    expect(comoCandidato(ana)).toEqual({
      userId: 'ana',
      canales: [Channel.STAFF_CUSTOMER],
      disponible: true,
      tope: 12,
      abiertas: 3,
      ultimaAsignacion: null,
    });
  });

  it('fuera del horario de atención de la empresa nadie está disponible', async () => {
    // Sólo atiende los domingos: el martes, cerrado.
    const { servicio } = armar({
      personal: [persona('ana', ['mensajes.clientes'])],
      guardados: [['ana', { status: 'online' }]],
      conexiones: [['ana', conectada]],
      franjas: [{ weekday: 0, opensAt: '08:00', closesAt: '12:00' }],
    });
    const [ana] = await servicio.delaEmpresa(A, AHORA);
    expect(ana.available).toBe(false);
    // Los martes de 9 a 18: disponible.
    const abierta = armar({
      personal: [persona('ana', ['mensajes.clientes'])],
      guardados: [['ana', { status: 'online' }]],
      conexiones: [['ana', conectada]],
      franjas: [{ weekday: 2, opensAt: '09:00', closesAt: '18:00' }],
    });
    expect((await abierta.servicio.delaEmpresa(A, AHORA))[0].available).toBe(
      true,
    );
  });

  it('sin Redis nadie figura conectado (falla cerrado) y el equipo igual se lista', async () => {
    const { servicio } = armar({
      personal: [persona('ana', ['mensajes.clientes'])],
      guardados: [['ana', { status: 'online' }]],
      presenciaRota: true,
    });
    const [ana] = await servicio.delaEmpresa(A, AHORA);
    expect(ana).toMatchObject({ connected: false, available: false });
  });

  it('persona: la del equipo o `null` (otra empresa, sin permiso de ningún canal)', async () => {
    const { servicio } = armar({
      personal: [
        persona('ana', ['mensajes.clientes']),
        persona('beto', ['pedidos.ver']),
      ],
    });
    expect((await servicio.persona(A, 'ana', AHORA))?.userId).toBe('ana');
    expect(await servicio.persona(A, 'beto', AHORA)).toBeNull();
    expect(await servicio.persona(A, 'de-otra-empresa', AHORA)).toBeNull();
  });

  it('chat:team: una vez por cambio, sólo de quienes se piden, sin datos de contacto', async () => {
    const m = armar({
      personal: [
        persona('ana', ['mensajes.clientes']),
        persona('beto', ['mensajes.choferes']),
      ],
      guardados: [['ana', { status: 'online' }]],
      conexiones: [['ana', conectada]],
      abiertas: [['ana', 2]],
    });
    await m.servicio.avisar(A, ['ana'], AHORA);
    await m.servicio.avisar(A, ['ana'], AHORA);
    expect(m.panel.emitirAlEquipoDeLaBandeja).toHaveBeenCalledTimes(1);
    expect(m.panel.emitirAlEquipoDeLaBandeja).toHaveBeenCalledWith(
      A,
      EVENTO_SOCKET_EQUIPO,
      {
        userId: 'ana',
        status: 'online',
        connected: true,
        available: true,
        openAssigned: 2,
      },
    );
    await m.servicio.avisar(A, undefined, AHORA);
    expect(m.panel.emitirAlEquipoDeLaBandeja).toHaveBeenCalledTimes(2);
    expect(m.panel.emitirAlEquipoDeLaBandeja).toHaveBeenLastCalledWith(
      A,
      EVENTO_SOCKET_EQUIPO,
      expect.objectContaining({ userId: 'beto' }),
    );
  });

  it('chat:team es best-effort: si falla, no sube', async () => {
    const m = armar({ personal: [persona('ana', ['mensajes.clientes'])] });
    m.presencia.cambioElEstado.mockRejectedValueOnce(new Error('sin Redis'));
    await expect(m.servicio.avisar(A, ['ana'], AHORA)).resolves.toBeUndefined();
    expect(m.panel.emitirAlEquipoDeLaBandeja).not.toHaveBeenCalled();
  });

  it('con el `manager` de una transacción, todo va por él (nunca una segunda conexión) y con la presencia ya leída no toca Redis', async () => {
    const lectura = new BandejaReadModel({
      query: jest.fn(() => {
        throw new Error('segunda conexión del pool');
      }),
    } as unknown as DataSource);
    const m = armar({ conexiones: [['ana', conectada]] });
    const delManager = jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('FROM "admin"')
          ? [
              {
                user_id: 'ana',
                full_name: 'Ana',
                photo_key: null,
                is_system: false,
                permissions: ['mensajes.clientes'],
              },
            ]
          : [],
      ),
    );
    const manager = { query: delManager } as unknown as EntityManager;
    const servicio = new EquipoDeLaBandejaService(
      {
        manager: {
          query: () => {
            throw new Error('segunda conexión del pool');
          },
        },
      } as unknown as DataSource,
      lectura,
      m.agentes as unknown as AgentesDeLaBandeja,
      m.presencia as unknown as PresenciaDeLaBandeja,
      m.ajustes as unknown as CompanyChatSettingsService,
      m.panel as unknown as AdminGateway,
    );
    const equipo = await servicio.delaEmpresa(A, AHORA, {
      manager,
      conexiones: new Map([['ana', conectada]]),
    });
    expect(equipo.map((a) => a.userId)).toEqual(['ana']);
    expect(delManager).toHaveBeenCalledWith(
      expect.stringContaining('FROM "admin"'),
      [A],
    );
    expect(m.agentes.ajustes).toHaveBeenCalledWith(manager, A);
    expect(m.agentes.abiertasPorPersona).toHaveBeenCalledWith(manager, A);
    expect(m.ajustes.leer).toHaveBeenCalledWith(A, manager);
    expect(m.presencia.deLaEmpresa).not.toHaveBeenCalled();
  });

  it('Redis que no contesta: a los 1500 ms nadie figura conectado, sin quedarse esperando', async () => {
    jest.useFakeTimers();
    try {
      const m = armar({ personal: [persona('ana', ['mensajes.clientes'])] });
      m.presencia.deLaEmpresa.mockReturnValueOnce(new Promise(() => {}));
      const lectura = m.servicio.conexionesDe(A, AHORA);
      await jest.advanceTimersByTimeAsync(ESPERA_DE_LA_PRESENCIA_MS);
      expect((await lectura).size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
