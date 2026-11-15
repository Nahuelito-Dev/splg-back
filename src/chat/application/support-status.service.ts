import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { errorMessage } from '../../common/errors/error-message';
import {
  AdminGateway,
  type ConexionDelSoporte,
  EVENTO_SOPORTE_CONECTADO,
  EVENTO_SOPORTE_DESCONECTADO,
} from '../../gateways/admin.gateway';
import { estaAbierto, proximaApertura } from '../domain/horario';
import {
  LATIDO_MS,
  PresenciaDelEquipo,
} from '../infrastructure/presencia-del-equipo';
import { SupportSettingsService } from './support-settings.service';

/** El estado del soporte cambió: se avisa a las empresas por el socket. */
export const EVENTO_ESTADO_DEL_SOPORTE = 'chat.soporte.estado';

/** Lo que la empresa ve del soporte de la plataforma (D-C26). Sin datos del equipo. */
export interface EstadoDelSoporte {
  openNow: boolean;
  nextOpenAt: string | null;
  teamOnline: boolean;
}

/**
 * Estado del soporte para la empresa (D-C26): si se atiende ahora según el
 * horario, cuándo vuelve a abrir y si hay alguien del equipo conectado. La
 * presencia la alimentan las conexiones del panel de la plataforma (conexión,
 * desconexión y un latido por instancia); cuando el estado cambia se avisa
 * una sola vez, aunque haya varias instancias.
 */
@Injectable()
export class SupportStatusService {
  private readonly logger = new Logger(SupportStatusService.name);

  constructor(
    private readonly configuracion: SupportSettingsService,
    private readonly presencia: PresenciaDelEquipo,
    private readonly gateway: AdminGateway,
    private readonly events: EventEmitter2,
  ) {}

  async estado(ahora: Date = new Date()): Promise<EstadoDelSoporte> {
    const [c, personas] = await Promise.all([
      this.configuracion.leer(),
      this.presencia.personasConectadas(ahora.getTime()),
    ]);
    return {
      openNow: estaAbierto(c.chatHours, c.timezone, ahora),
      nextOpenAt:
        proximaApertura(c.chatHours, c.timezone, ahora)?.toISOString() ?? null,
      teamOnline: personas > 0,
    };
  }

  /** Recalcula el estado y, si cambió desde el último aviso, lo avisa. */
  async avisarSiCambio(ahora: Date = new Date()): Promise<void> {
    const estado = await this.estado(ahora);
    if (await this.presencia.cambioElEstado(JSON.stringify(estado))) {
      this.events.emit(EVENTO_ESTADO_DEL_SOPORTE, estado);
    }
  }

  @OnEvent(EVENTO_SOPORTE_CONECTADO, { async: true })
  async conectado(conexion: ConexionDelSoporte): Promise<void> {
    await this.seguro(async () => {
      await this.presencia.marcar([conexion]);
      await this.avisarSiCambio();
    });
  }

  @OnEvent(EVENTO_SOPORTE_DESCONECTADO, { async: true })
  async desconectado(conexion: ConexionDelSoporte): Promise<void> {
    await this.seguro(async () => {
      await this.presencia.quitar(conexion);
      await this.avisarSiCambio();
    });
  }

  /**
   * El latido: renueva las conexiones de esta instancia y recalcula (así se
   * notan las de una instancia caída que vencieron y el paso de abierto a
   * cerrado según el horario).
   */
  @Interval(LATIDO_MS)
  async latido(): Promise<void> {
    await this.seguro(async () => {
      await this.presencia.marcar(this.gateway.conexionesLocalesDelSoporte());
      await this.avisarSiCambio();
    });
  }

  /** Best-effort: sin Redis la presencia no anda, pero el panel sigue. */
  private async seguro(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.warn(
        `No se pudo actualizar la presencia del soporte: ${errorMessage(error)}`,
      );
    }
  }
}
