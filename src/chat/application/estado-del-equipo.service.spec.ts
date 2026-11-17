import { HttpException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import type { AdminGateway } from '../../gateways/admin.gateway';
import { Channel, Party } from '../domain/chat.enums';
import type { AgentesDeLaBandeja } from '../infrastructure/agentes-de-la-bandeja';
import type { PresenciaDeLaBandeja } from '../infrastructure/presencia-de-la-bandeja';
import type { AsignacionAutomaticaService } from './asignacion-automatica.service';
import type { ActorDeLaBandeja } from './bandeja-acceso';
import type {
  AgenteDeLaBandeja,
  EquipoDeLaBandejaService,
} from './equipo-de-la-bandeja.service';
import { EstadoDelEquipoService } from './estado-del-equipo.service';

const A = 'dist-a';
const actor: ActorDeLaBandeja = {
  party: Party.COMPANY,
  userId: 'ana',
  distributorId: A,
  canales: [Channel.STAFF_CUSTOMER],
  permisos: ['mensajes.clientes'],
};

const agente = (userId: string): AgenteDeLaBandeja => ({
  userId,
  name: userId,
  status: 'away',
  connected: true,
  available: false,
  maxOpen: 5,
  maxOpenOverride: null,
  openAssigned: 0,
  channels: [Channel.STAFF_CUSTOMER],
  lastAssignedAt: null,
});

function armar(delEquipo: string[] = ['ana']) {
  const orden: string[] = [];
  const manager = {
    query: jest.fn((sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) orden.push('cerrojo');
      return Promise.resolve([]);
    }),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn((fn: (m: EntityManager) => Promise<unknown>) =>
      fn(manager),
    ),
  } as unknown as DataSource;
  const equipo = {
    persona: jest.fn((_d: string, u: string) =>
      Promise.resolve(delEquipo.includes(u) ? agente(u) : null),
    ),
    delaEmpresa: jest.fn(() => Promise.resolve(delEquipo.map(agente))),
    avisar: jest.fn(() => Promise.resolve()),
  };
  const agentes = {
    guardarEstado: jest.fn(() => {
      orden.push('estado');
      return Promise.resolve();
    }),
    guardarTope: jest.fn(() => {
      orden.push('tope');
      return Promise.resolve();
    }),
  };
  const asignacion = {
    // Disparar no se espera: aunque el reparto no terminara nunca, la
    // operación responde (8b, ronda 2).
    disparar: jest.fn(() => {
      orden.push('reparto');
    }),
    repartirSinFallar: jest.fn(() => new Promise(() => {})),
  };
  const presencia = {
    marcar: jest.fn(() => Promise.resolve()),
    quitar: jest.fn(() => Promise.resolve()),
  };
  const panel = {
    conexionesLocalesDeLaBandeja: jest.fn(() => [
      { distributorId: A, userId: 'ana', socketId: 's1' },
    ]),
  };
  const servicio = new EstadoDelEquipoService(
    dataSource,
    equipo as unknown as EquipoDeLaBandejaService,
    agentes as unknown as AgentesDeLaBandeja,
    asignacion as unknown as AsignacionAutomaticaService,
    presencia as unknown as PresenciaDeLaBandeja,
    panel as unknown as AdminGateway,
  );
  return { servicio, equipo, agentes, asignacion, presencia, orden };
}

const estado = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof HttpException
      ? [e.getStatus(), (e.getResponse() as { code?: string }).code ?? null]
      : 'otro';
  }
};

describe('EstadoDelEquipoService (8b)', () => {
  it('mi estado: el de la persona; quien no es del equipo → 403 PERMISSION_DENIED', async () => {
    const { servicio } = armar();
    expect((await servicio.mio(actor)).userId).toBe('ana');
    const otro = armar([]);
    expect(await estado(otro.servicio.mio(actor))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
  });

  it('ponerse en línea: con el cerrojo del reparto, después reparte y avisa al equipo', async () => {
    const m = armar();
    await m.servicio.cambiarElMio(actor, 'online');
    expect(m.agentes.guardarEstado).toHaveBeenCalledWith(
      expect.anything(),
      A,
      'ana',
      'online',
      expect.any(Date),
    );
    expect(m.orden).toEqual(['cerrojo', 'estado', 'reparto']);
    // Dispara el reparto, no lo espera.
    expect(m.asignacion.repartirSinFallar).not.toHaveBeenCalled();
    expect(m.equipo.avisar).toHaveBeenCalledWith(A, ['ana']);
  });

  it('ponerse ausente no reparte (no suma a nadie disponible)', async () => {
    const m = armar();
    await m.servicio.cambiarElMio(actor, 'away');
    expect(m.asignacion.disparar).not.toHaveBeenCalled();
    expect(m.equipo.avisar).toHaveBeenCalledWith(A, ['ana']);
  });

  it('quien no es del equipo no guarda nada', async () => {
    const m = armar([]);
    expect(await estado(m.servicio.cambiarElMio(actor, 'online'))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    expect(m.agentes.guardarEstado).not.toHaveBeenCalled();
  });

  it('el tope propio: de alguien del equipo, con el cerrojo, y reparte', async () => {
    const m = armar(['ana', 'beto']);
    const r = await m.servicio.cambiarTope(A, 'beto', 8);
    expect(r.userId).toBe('beto');
    expect(m.agentes.guardarTope).toHaveBeenCalledWith(
      expect.anything(),
      A,
      'beto',
      8,
    );
    expect(m.orden).toEqual(['cerrojo', 'tope', 'reparto']);
    expect(m.equipo.avisar).toHaveBeenCalledWith(A, ['beto']);
  });

  it('el tope de alguien que no es del equipo de la empresa (otra empresa, sin canal) → 404, sin guardar', async () => {
    const m = armar(['ana']);
    expect(await estado(m.servicio.cambiarTope(A, 'de-otra', 8))).toEqual([
      404,
      null,
    ]);
    expect(m.agentes.guardarTope).not.toHaveBeenCalled();
    expect(m.asignacion.disparar).not.toHaveBeenCalled();
  });

  it('el tablero: el equipo de la empresa', async () => {
    const m = armar(['ana', 'beto']);
    expect((await m.servicio.listar(A)).map((a) => a.userId)).toEqual([
      'ana',
      'beto',
    ]);
  });

  it('presencia: al conectarse cuenta y reparte; al desconectarse sale; el latido renueva las locales', async () => {
    const m = armar();
    const conexion = { distributorId: A, userId: 'ana', socketId: 's1' };
    await m.servicio.conectado(conexion);
    expect(m.presencia.marcar).toHaveBeenCalledWith([conexion]);
    expect(m.asignacion.disparar).toHaveBeenCalledWith(A);
    await m.servicio.desconectado(conexion);
    expect(m.presencia.quitar).toHaveBeenCalledWith(conexion);
    expect(m.equipo.avisar).toHaveBeenCalledTimes(2);
    await m.servicio.latido();
    expect(m.presencia.marcar).toHaveBeenLastCalledWith([conexion]);
  });

  it('presencia sin Redis: no rompe', async () => {
    const m = armar();
    m.presencia.marcar.mockRejectedValueOnce(new Error('sin Redis'));
    await expect(m.servicio.latido()).resolves.toBeUndefined();
  });
});
