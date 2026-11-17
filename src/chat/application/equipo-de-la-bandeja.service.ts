import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { permisosEfectivos } from '../../common/permisos/catalogo';
import { errorMessage } from '../../common/errors/error-message';
import { AdminGateway } from '../../gateways/admin.gateway';
import {
  type Candidato,
  ESTADO_POR_OMISION,
  type EstadoDelAgente,
  estaDisponible,
  topeDe,
} from '../domain/asignacion-automatica';
import { atiendeElCanal, type CanalDeLaBandeja } from '../domain/bandeja';
import { Channel } from '../domain/chat.enums';
import { atiendeLaEmpresa } from '../domain/horario-de-la-empresa';
import type { ChatCompanySettings } from '../entities/chat-company-settings.entity';
import { AgentesDeLaBandeja } from '../infrastructure/agentes-de-la-bandeja';
import { BandejaReadModel } from '../infrastructure/bandeja-read-model';
import {
  type ConexionDeLaPersona,
  PresenciaDeLaBandeja,
} from '../infrastructure/presencia-de-la-bandeja';
import {
  CompanyChatSettingsService,
  horarioDe,
} from './company-chat-settings.service';

/** Lo más que se espera a Redis para saber quién está conectado. */
export const ESPERA_DE_LA_PRESENCIA_MS = 1500;

/** Evento del socket del panel con el estado de una persona del equipo (8b). */
export const EVENTO_SOCKET_EQUIPO = 'chat:team';

/** Una persona del equipo de la bandeja, con todo lo que pesa para asignarle. */
export interface AgenteDeLaBandeja {
  userId: string;
  name: string;
  status: EstadoDelAgente;
  connected: boolean;
  available: boolean;
  /** El tope que le rige: el suyo o el de la empresa. */
  maxOpen: number;
  maxOpenOverride: number | null;
  openAssigned: number;
  channels: CanalDeLaBandeja[];
  lastAssignedAt: Date | null;
}

const CANALES: readonly CanalDeLaBandeja[] = [
  Channel.STAFF_CUSTOMER,
  Channel.STAFF_DRIVER,
];

/** Lo que pide el reparto de cada persona. */
export function comoCandidato(a: AgenteDeLaBandeja): Candidato {
  return {
    userId: a.userId,
    canales: a.channels,
    disponible: a.available,
    tope: a.maxOpen,
    abiertas: a.openAssigned,
    ultimaAsignacion: a.lastAssignedAt?.getTime() ?? null,
  };
}

/**
 * El equipo de la bandeja de una empresa (8b): quiénes son (el personal
 * vigente con permiso de algún canal), su estado elegido, su conexión al
 * panel, su tope y su carga. Y el aviso `chat:team` al tablero del
 * supervisor cuando algo de una persona cambia (una sola vez por cambio,
 * aunque haya varias instancias).
 */
@Injectable()
export class EquipoDeLaBandejaService {
  private readonly logger = new Logger(EquipoDeLaBandejaService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly lectura: BandejaReadModel,
    private readonly agentes: AgentesDeLaBandeja,
    private readonly presencia: PresenciaDeLaBandeja,
    private readonly ajustes: CompanyChatSettingsService,
    private readonly panel: AdminGateway,
  ) {}

  /**
   * El equipo de la empresa, por nombre. Sin conexión a Redis, nadie figura
   * conectado (y nadie recibe conversaciones): falla cerrado.
   *
   * Dentro de la transacción del reparto se pasan su `manager` (todo va por
   * esa conexión, nunca una segunda del pool) y la presencia ya leída antes
   * de abrirla (Redis no se consulta con el cerrojo tomado).
   */
  async delaEmpresa(
    distributorId: string,
    ahora: Date = new Date(),
    opciones: {
      manager?: EntityManager;
      ajustes?: ChatCompanySettings;
      conexiones?: ReadonlyMap<string, ConexionDeLaPersona>;
    } = {},
  ): Promise<AgenteDeLaBandeja[]> {
    const manager = opciones.manager ?? this.dataSource.manager;
    const conexiones =
      opciones.conexiones ?? (await this.conexionesDe(distributorId, ahora));
    // En serie: con un `manager` de transacción es una sola conexión.
    const personal = await this.lectura.personalDeLaEmpresa(
      distributorId,
      manager,
    );
    const guardados = await this.agentes.ajustes(manager, distributorId);
    const abiertas = await this.agentes.abiertasPorPersona(
      manager,
      distributorId,
    );
    const a =
      opciones.ajustes ?? (await this.ajustes.leer(distributorId, manager));
    const enHorario = atiendeLaEmpresa(horarioDe(a), ahora);
    const equipo: AgenteDeLaBandeja[] = [];
    for (const p of personal) {
      const rol = { todos: p.todos, permisos: permisosEfectivos(p.permisos) };
      const channels = CANALES.filter((c) => atiendeElCanal(rol, c));
      if (channels.length === 0) continue;
      const g = guardados.get(p.userId);
      const status = g?.status ?? ESTADO_POR_OMISION;
      const conexion = conexiones.get(p.userId);
      const connected = conexion?.conectado ?? false;
      const maxOpenOverride = g?.maxOpenOverride ?? null;
      equipo.push({
        userId: p.userId,
        name: p.fullName,
        status,
        connected,
        available: estaDisponible(
          {
            estado: status,
            conectado: connected,
            vistoEn: conexion?.vistoEn ?? null,
            enHorario,
          },
          ahora.getTime(),
        ),
        maxOpen: topeDe(maxOpenOverride, a.autoAssignMaxOpen),
        maxOpenOverride,
        openAssigned: abiertas.get(p.userId) ?? 0,
        channels,
        lastAssignedAt: g?.lastAssignedAt ?? null,
      });
    }
    return equipo;
  }

  /** Una persona del equipo de la empresa, o `null` si no es del equipo (otra empresa, sin permiso de ningún canal). */
  async persona(
    distributorId: string,
    userId: string,
    ahora: Date = new Date(),
  ): Promise<AgenteDeLaBandeja | null> {
    const equipo = await this.delaEmpresa(distributorId, ahora);
    return equipo.find((a) => a.userId === userId) ?? null;
  }

  /**
   * `chat:team` al equipo de la empresa por cada una de esas personas (o
   * todas) cuyo estado, conexión, disponibilidad o carga cambió desde el
   * último aviso. Best-effort: un aviso que no sale no rompe la operación.
   */
  async avisar(
    distributorId: string,
    userIds?: readonly string[],
    ahora: Date = new Date(),
  ): Promise<void> {
    try {
      const equipo = await this.delaEmpresa(distributorId, ahora);
      const quienes = userIds ? new Set(userIds) : null;
      for (const a of equipo) {
        if (quienes && !quienes.has(a.userId)) continue;
        const payload = {
          userId: a.userId,
          status: a.status,
          connected: a.connected,
          available: a.available,
          openAssigned: a.openAssigned,
        };
        if (
          await this.presencia.cambioElEstado(
            distributorId,
            a.userId,
            JSON.stringify(payload),
          )
        ) {
          this.panel.emitirAlEquipoDeLaBandeja(
            distributorId,
            EVENTO_SOCKET_EQUIPO,
            payload,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `No se pudo avisar el estado del equipo de ${distributorId}: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * La conexión de cada persona, con un tope de espera: si Redis no contesta
   * en {@link ESPERA_DE_LA_PRESENCIA_MS} (caído, reconectando), nadie figura
   * conectado y nada queda esperando a Redis.
   */
  async conexionesDe(
    distributorId: string,
    ahora: Date = new Date(),
  ): Promise<Map<string, ConexionDeLaPersona>> {
    let vencio: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.presencia.deLaEmpresa(distributorId, ahora.getTime()),
        new Promise<never>((_, rechazar) => {
          vencio = setTimeout(
            () => rechazar(new Error('Redis no contestó a tiempo')),
            ESPERA_DE_LA_PRESENCIA_MS,
          );
        }),
      ]);
    } catch (error) {
      this.logger.warn(
        `No se pudo leer la presencia del equipo de ${distributorId}: ${errorMessage(error)}`,
      );
      return new Map<string, ConexionDeLaPersona>();
    } finally {
      clearTimeout(vencio);
    }
  }
}
