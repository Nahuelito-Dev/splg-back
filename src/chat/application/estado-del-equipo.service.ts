import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import {
  AdminGateway,
  type ConexionDelPersonal,
  EVENTO_BANDEJA_CONECTADO,
  EVENTO_BANDEJA_DESCONECTADO,
} from '../../gateways/admin.gateway';
import type { EstadoDelAgente } from '../domain/asignacion-automatica';
import { AgentesDeLaBandeja } from '../infrastructure/agentes-de-la-bandeja';
import {
  LATIDO_DE_LA_BANDEJA_MS,
  PresenciaDeLaBandeja,
} from '../infrastructure/presencia-de-la-bandeja';
import {
  AsignacionAutomaticaService,
  bloquearElReparto,
} from './asignacion-automatica.service';
import type { ActorDeLaBandeja } from './bandeja-acceso';
import { noExisteLaPersonaDelPersonal, sinPermiso } from './bandeja.errors';
import {
  type AgenteDeLaBandeja,
  EquipoDeLaBandejaService,
} from './equipo-de-la-bandeja.service';

/**
 * El estado de cada persona del equipo en la bandeja (8b): el propio («en
 * línea» o «ausente»), el tablero del equipo para quien supervisa o
 * configura, el tope propio de cada persona y la presencia (conexión y
 * desconexión del panel, más un latido por instancia). Lo que libera lugar
 * o suma a alguien disponible dispara el reparto de la cola.
 */
@Injectable()
export class EstadoDelEquipoService {
  private readonly logger = new Logger(EstadoDelEquipoService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly equipo: EquipoDeLaBandejaService,
    private readonly agentes: AgentesDeLaBandeja,
    private readonly asignacion: AsignacionAutomaticaService,
    private readonly presencia: PresenciaDeLaBandeja,
    private readonly panel: AdminGateway,
  ) {}

  /** El estado propio. Quien no es del equipo (sin permiso de ningún canal) → 403. */
  async mio(actor: ActorDeLaBandeja): Promise<AgenteDeLaBandeja> {
    const yo = await this.equipo.persona(actor.distributorId, actor.userId);
    if (!yo) throw sinPermiso('mensajes.clientes', 'mensajes.choferes');
    return yo;
  }

  /**
   * Ponerse en línea o ausente. En línea dispara el reparto de la cola sin
   * esperarlo (lo que le llegue sale por el socket y por `chat:team`).
   */
  async cambiarElMio(
    actor: ActorDeLaBandeja,
    status: EstadoDelAgente,
    ahora: Date = new Date(),
  ): Promise<AgenteDeLaBandeja> {
    await this.mio(actor);
    await this.dataSource.transaction(async (manager) => {
      await bloquearElReparto(manager, actor.distributorId);
      await this.agentes.guardarEstado(
        manager,
        actor.distributorId,
        actor.userId,
        status,
        ahora,
      );
    });
    if (status === 'online') {
      this.asignacion.disparar(actor.distributorId);
    }
    await this.equipo.avisar(actor.distributorId, [actor.userId]);
    return this.mio(actor);
  }

  /** El tablero: el equipo de la empresa (sin contacto: ni email ni teléfono). */
  listar(distributorId: string): Promise<AgenteDeLaBandeja[]> {
    return this.equipo.delaEmpresa(distributorId);
  }

  /**
   * El tope propio de una persona (`null`: vuelve al de la empresa). Alguien
   * que no es del equipo de la empresa (otra empresa, sin permiso de ningún
   * canal) → 404. Cambiarlo dispara el reparto.
   */
  async cambiarTope(
    distributorId: string,
    userId: string,
    tope: number | null,
  ): Promise<AgenteDeLaBandeja> {
    if (!(await this.equipo.persona(distributorId, userId))) {
      throw noExisteLaPersonaDelPersonal();
    }
    await this.dataSource.transaction(async (manager) => {
      await bloquearElReparto(manager, distributorId);
      await this.agentes.guardarTope(manager, distributorId, userId, tope);
    });
    this.asignacion.disparar(distributorId);
    await this.equipo.avisar(distributorId, [userId]);
    const actual = await this.equipo.persona(distributorId, userId);
    if (!actual) throw noExisteLaPersonaDelPersonal();
    return actual;
  }

  /** Se conectó: cuenta como presente y, si estaba en línea, puede recibir lo que espera. */
  @OnEvent(EVENTO_BANDEJA_CONECTADO, { async: true })
  async conectado(conexion: ConexionDelPersonal): Promise<void> {
    await this.seguro(async () => {
      await this.presencia.marcar([conexion]);
      this.asignacion.disparar(conexion.distributorId);
      await this.equipo.avisar(conexion.distributorId, [conexion.userId]);
    });
  }

  /** Se desconectó (una pestaña): sale de la presencia y empieza la gracia de dos minutos. */
  @OnEvent(EVENTO_BANDEJA_DESCONECTADO, { async: true })
  async desconectado(conexion: ConexionDelPersonal): Promise<void> {
    await this.seguro(async () => {
      await this.presencia.quitar(conexion);
      await this.equipo.avisar(conexion.distributorId, [conexion.userId]);
    });
  }

  /** El latido: renueva las conexiones de la bandeja que atiende esta instancia. */
  @Interval(LATIDO_DE_LA_BANDEJA_MS)
  async latido(): Promise<void> {
    await this.seguro(() =>
      this.presencia.marcar(this.panel.conexionesLocalesDeLaBandeja()),
    );
  }

  /** Best-effort: sin Redis la presencia no anda (nadie recibe sola), pero el panel sigue. */
  private async seguro(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.warn(
        `No se pudo actualizar la presencia de la bandeja: ${errorMessage(error)}`,
      );
    }
  }
}
