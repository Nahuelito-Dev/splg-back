import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { TicketPriority } from '../domain/chat.enums';
import { franjasValidas } from '../domain/horario';
import {
  OBJETIVOS_POR_DEFECTO,
  type ObjetivosDeRespuesta,
  type PlazosDelTicket,
} from '../domain/support-ticket.machine';
import { PlatformSupportSettings } from '../entities/platform-support-settings.entity';
import type { UpdateSupportSettingsDto } from '../presentation/dto/support-settings.dto';

/** La única fila de configuración. */
export const ID_DE_LA_CONFIGURACION = 1;

/** Los valores por defecto (los de la migración), para cuando todavía no hay fila. */
export function configuracionPorDefecto(): PlatformSupportSettings {
  return Object.assign(new PlatformSupportSettings(), {
    settingsId: ID_DE_LA_CONFIGURACION,
    timezone: 'America/Argentina/Buenos_Aires',
    chatHours: [],
    chatAckEnabled: true,
    chatAckMessage: null,
    chatInactivityHours: 24,
    resolvedCloseDays: 7,
    waitingCloseDays: 7,
    waitingWarnDays: 5,
    targetUrgentMinutes: OBJETIVOS_POR_DEFECTO[TicketPriority.URGENT],
    targetHighMinutes: OBJETIVOS_POR_DEFECTO[TicketPriority.HIGH],
    targetNormalMinutes: OBJETIVOS_POR_DEFECTO[TicketPriority.NORMAL],
    targetLowMinutes: OBJETIVOS_POR_DEFECTO[TicketPriority.LOW],
    updatedByUserId: null,
  });
}

export function objetivosDe(c: PlatformSupportSettings): ObjetivosDeRespuesta {
  return {
    [TicketPriority.URGENT]: c.targetUrgentMinutes,
    [TicketPriority.HIGH]: c.targetHighMinutes,
    [TicketPriority.NORMAL]: c.targetNormalMinutes,
    [TicketPriority.LOW]: c.targetLowMinutes,
  };
}

export function plazosDe(c: PlatformSupportSettings): PlazosDelTicket {
  return {
    waitingCloseDays: c.waitingCloseDays,
    waitingWarnDays: c.waitingWarnDays,
    resolvedCloseDays: c.resolvedCloseDays,
  };
}

function zonaValida(zona: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zona });
    return true;
  } catch {
    return false;
  }
}

/** Configuración del soporte de la plataforma (horario, objetivos, plazos). */
@Injectable()
export class SupportSettingsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async leer(
    manager: EntityManager = this.dataSource.manager,
  ): Promise<PlatformSupportSettings> {
    return (
      (await manager.getRepository(PlatformSupportSettings).findOne({
        where: { settingsId: ID_DE_LA_CONFIGURACION },
      })) ?? configuracionPorDefecto()
    );
  }

  async actualizar(
    userId: string,
    dto: UpdateSupportSettingsDto,
  ): Promise<PlatformSupportSettings> {
    if (dto.timezone !== undefined && !zonaValida(dto.timezone)) {
      throw new BadRequestException('La zona horaria no es válida');
    }
    if (dto.chatHours !== undefined && !franjasValidas(dto.chatHours)) {
      throw new BadRequestException(
        'El horario tiene franjas que se solapan o que cierran antes de abrir',
      );
    }
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(PlatformSupportSettings);
      const actual =
        (await repo.findOne({
          where: { settingsId: ID_DE_LA_CONFIGURACION },
          lock: { mode: 'pessimistic_write' },
        })) ?? configuracionPorDefecto();
      const nueva = Object.assign(actual, dto, { updatedByUserId: userId });
      if (nueva.waitingWarnDays >= nueva.waitingCloseDays) {
        throw new BadRequestException(
          'El aviso de un ticket sin respuesta tiene que llegar antes de cerrarlo',
        );
      }
      return repo.save(nueva);
    });
  }
}
