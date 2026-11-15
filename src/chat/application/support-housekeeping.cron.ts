import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import { ProcessName } from '../../process-run/domain/process-catalog';
import {
  marcarSaltada,
  registrarErrorAtrapado,
} from '../../process-run/process-run.context';
import { ConRegistro } from '../../process-run/process-run.recorder';
import { RedisService } from '../../redis/redis.service';
import { TicketStatus } from '../domain/chat.enums';
import { vencimientoDelTicket } from '../domain/support-ticket.machine';
import { SupportTicket } from '../entities/support-ticket.entity';
import { ChatNotices } from './chat-notices';
import { PlatformChatService } from './platform-chat.service';
import { plazosDe, SupportSettingsService } from './support-settings.service';
import { TicketActivityService } from './ticket-activity.service';
import { nombreDeLaEmpresa } from './ticket-store';

export interface ResultadoDelMantenimiento {
  chatsClosed: number;
  ticketsClosed: number;
  warned: number;
  overdue: number;
}

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Mantenimiento del soporte de la plataforma, cada 10 minutos (una sola
 * instancia, con cerrojo):
 *  - cierra los chats sin mensajes hace más de las horas configuradas (24);
 *  - cierra los tickets esperando a la empresa o resueltos hace 7 días, y
 *    avisa a la empresa a los 5 días de esperar su respuesta;
 *  - avisa a la plataforma de los tickets que pasaron su objetivo de primera
 *    respuesta.
 * Los avisos no se repiten (clave de la bandeja por ticket y período).
 */
@Injectable()
export class SupportHousekeepingCron {
  static readonly CERROJO = 'cron:support-housekeeping';
  static readonly CERROJO_TTL_MS = 9 * 60_000;

  private readonly logger = new Logger(SupportHousekeepingCron.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly ajustes: SupportSettingsService,
    private readonly chats: PlatformChatService,
    private readonly tickets: TicketActivityService,
    private readonly avisos: ChatNotices,
  ) {}

  @Cron('0 */10 * * * *') // cada diez minutos
  @ConRegistro(ProcessName.SUPPORT_HOUSEKEEPING)
  async mantener(): Promise<ResultadoDelMantenimiento | undefined> {
    try {
      const bloqueo = await this.redis.withLock(
        SupportHousekeepingCron.CERROJO,
        SupportHousekeepingCron.CERROJO_TTL_MS,
        () => this.barrer(new Date()),
      );
      if (bloqueo.obtenido) return bloqueo.valor;
      marcarSaltada();
      this.logger.log(
        'Mantenimiento del soporte: lo está procesando otra instancia',
      );
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error(
        `Mantenimiento del soporte: la ejecución falló: ${errorMessage(error)}`,
      );
    }
    return undefined;
  }

  async barrer(ahora: Date): Promise<ResultadoDelMantenimiento> {
    const ajustes = await this.ajustes.leer();
    const plazos = plazosDe(ajustes);
    const resultado: ResultadoDelMantenimiento = {
      chatsClosed: await this.chats.cerrarInactivos(
        ahora,
        ajustes.chatInactivityHours,
      ),
      ticketsClosed: 0,
      warned: 0,
      overdue: 0,
    };

    const enEspera = await this.dataSource.getRepository(SupportTicket).find({
      where: [
        { status: TicketStatus.WAITING_COMPANY },
        { status: TicketStatus.RESOLVED },
      ],
    });
    for (const t of enEspera) {
      const decision = vencimientoDelTicket(
        t.status,
        t.statusChangedAt,
        ahora,
        plazos,
      );
      if (decision === 'close') {
        const cerrado = await this.tickets.cerrarVencido(
          t.ticketId,
          (actual) =>
            vencimientoDelTicket(
              actual.status,
              actual.statusChangedAt,
              ahora,
              plazos,
            ) === 'close',
        );
        if (cerrado) resultado.ticketsClosed += 1;
      } else if (decision === 'warn') {
        const quedan = Math.max(
          1,
          Math.ceil(
            plazos.waitingCloseDays -
              (ahora.getTime() - t.statusChangedAt.getTime()) / DIA_MS,
          ),
        );
        this.avisos.porCerrarse(t, quedan);
        resultado.warned += 1;
      }
    }

    const vencidos: SupportTicket[] = await this.dataSource
      .getRepository(SupportTicket)
      .createQueryBuilder('t')
      .where('t.firstResponseAt IS NULL')
      .andWhere('t.firstResponseDueAt < :ahora', { ahora })
      .andWhere('t.status <> :cerrado', { cerrado: TicketStatus.CLOSED })
      .getMany();
    for (const t of vencidos) {
      this.avisos.sinPrimeraRespuesta(
        t,
        await nombreDeLaEmpresa(this.dataSource.manager, t.distributorId),
      );
      resultado.overdue += 1;
    }
    return resultado;
  }
}
