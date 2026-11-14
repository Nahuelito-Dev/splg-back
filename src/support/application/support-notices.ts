import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ConfiguracionDePlataforma } from '../../common/config/plataforma.config';
import { NOMBRE_DE_PLATAFORMA_POR_DEFECTO } from '../../common/config/plataforma.config';
import { pedirAvisoAlAdmin } from '../../common/events/aviso-al-admin';
import { SupportScope } from '../domain/support-session.enums';
import type { SupportSession } from '../entities/support-session.entity';

/** Tipos de aviso del modo soporte en la bandeja del admin. */
export const AVISO_SOPORTE_PEDIDO = 'support_access_requested';
export const AVISO_SOPORTE_EMERGENCIA = 'support_emergency_opened';
export const AVISO_SOPORTE_AUTOAPROBADO = 'support_access_auto_approved';

/** Entidad del enlace del aviso: lleva a «Accesos de soporte» del panel. */
export const ENLACE_DE_SOPORTE = 'support-session';

const ALCANCE_LEGIBLE: Record<SupportScope, string> = {
  [SupportScope.PERSONAL_DATA]: 'datos personales',
  [SupportScope.FILES]: 'archivos',
  [SupportScope.EXPORTS]: 'exportes',
};

/** «sólo lo básico» o la lista de lo pedido, en castellano. */
export function alcanceLegible(alcance: readonly SupportScope[]): string {
  if (alcance.length === 0)
    return 'sólo lo básico, con datos sensibles ocultos';
  return alcance.map((a) => ALCANCE_LEGIBLE[a]).join(', ');
}

/**
 * Avisos a la empresa (bandeja del panel y correo a sus admins) cuando el
 * soporte de la plataforma pide acceso, abre una emergencia o entra por
 * autoaprobación. Best-effort: el hecho ya ocurrió.
 */
@Injectable()
export class SupportNotices {
  private readonly logger = new Logger(SupportNotices.name);

  constructor(
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

  pedido(sesion: SupportSession): void {
    this.avisar(
      sesion,
      AVISO_SOPORTE_PEDIDO,
      `El soporte de ${this.plataforma()} pidió acceso de lectura`,
      `Pidió ${sesion.requestedMinutes} minutos de acceso de sólo lectura (${alcanceLegible(sesion.scope)}). Motivo: ${sesion.reason}\nPodés aprobarlo, achicarlo o rechazarlo en «Accesos de soporte». Si nadie responde, caduca en 24 horas.`,
    );
  }

  emergencia(sesion: SupportSession): void {
    this.avisar(
      sesion,
      AVISO_SOPORTE_EMERGENCIA,
      `El soporte de ${this.plataforma()} abrió un acceso de emergencia`,
      `Tiene acceso de sólo lectura por ${sesion.requestedMinutes} minutos (${alcanceLegible(sesion.scope)}), sin aprobación previa. Motivo: ${sesion.reason}\nPodés revocarlo cuando quieras en «Accesos de soporte».`,
    );
  }

  autoaprobado(sesion: SupportSession): void {
    this.avisar(
      sesion,
      AVISO_SOPORTE_AUTOAPROBADO,
      `El soporte de ${this.plataforma()} entró con aprobación automática`,
      `Tiene acceso de sólo lectura por ${sesion.requestedMinutes} minutos (${alcanceLegible(sesion.scope)}), aprobado por la política de la empresa. Motivo: ${sesion.reason}\nPodés revocarlo cuando quieras en «Accesos de soporte».`,
    );
  }

  private avisar(
    sesion: SupportSession,
    kind: string,
    title: string,
    body: string,
  ): void {
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: sesion.distributorId,
      kind,
      title,
      body,
      link: { entity: ENLACE_DE_SOPORTE, id: sesion.supportSessionId },
      dedupeKey: `${ENLACE_DE_SOPORTE}:${sesion.supportSessionId}:${kind}`,
      email: true,
    });
  }

  private plataforma(): string {
    return (
      this.config.get<ConfiguracionDePlataforma>('plataforma')?.name ??
      NOMBRE_DE_PLATAFORMA_POR_DEFECTO
    );
  }
}
