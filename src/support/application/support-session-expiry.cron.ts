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
import {
  SupportEndReason,
  SupportSessionStatus,
} from '../domain/support-session.enums';
import { AccionDeSoporte } from '../domain/support-session.machine';
import { SupportSessionCache } from './support-session.cache';
import { SupportEndedNotice } from './support-ended.notice';
import { SupportSession } from '../entities/support-session.entity';
import {
  bloquearSesion,
  cierre,
  transicionar,
} from './support-session.transitions';

export interface ResultadoDelVencimiento {
  expired: number;
  expiredRequests: number;
}

/**
 * Deja prolijo el historial del modo soporte: pasa a `expired` las sesiones
 * activas que ya vencieron y a `expired_request` los pedidos que pasaron sus
 * 24 horas sin respuesta. La seguridad no depende de esto (el `AuthGuard`
 * compara el vencimiento en cada request); por eso corre cada 5 minutos.
 * Con varias instancias corre una sola (cerrojo distribuido).
 */
@Injectable()
export class SupportSessionExpiryCron {
  static readonly CERROJO = 'cron:support-session-expiry';
  static readonly CERROJO_TTL_MS = 4 * 60_000;

  private readonly logger = new Logger(SupportSessionExpiryCron.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly cache: SupportSessionCache,
    private readonly fin: SupportEndedNotice,
  ) {}

  @Cron('0 */5 * * * *') // cada cinco minutos
  @ConRegistro(ProcessName.SUPPORT_SESSION_EXPIRY)
  async vencer(): Promise<ResultadoDelVencimiento | undefined> {
    try {
      const bloqueo = await this.redis.withLock(
        SupportSessionExpiryCron.CERROJO,
        SupportSessionExpiryCron.CERROJO_TTL_MS,
        () => this.barrer(),
      );
      if (bloqueo.obtenido) return bloqueo.valor;
      marcarSaltada();
      this.logger.log(
        'Vencimiento de soporte: lo está procesando otra instancia',
      );
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error(
        `Vencimiento de soporte: la ejecución falló: ${errorMessage(error)}`,
      );
    }
    return undefined;
  }

  /** Cierra cada vencida por la máquina de estados, una por transacción. */
  async barrer(): Promise<ResultadoDelVencimiento> {
    const candidatas: Array<{ id: string; status: SupportSessionStatus }> =
      await this.dataSource.query(
        `SELECT "support_session_id" AS id, "status" FROM "support_session"
          WHERE ("status" = 'active' AND "expires_at" <= now())
             OR ("status" = 'pending' AND "request_expires_at" <= now())
          ORDER BY "created_at"`,
      );
    const resultado: ResultadoDelVencimiento = {
      expired: 0,
      expiredRequests: 0,
    };
    for (const { id } of candidatas) {
      let vencida: SupportSession | null = null;
      const cerrada = await this.dataSource.transaction(async (manager) => {
        // Se vuelve a leer con bloqueo: entre la consulta y acá pudo haberla
        // aprobado, revocado o cerrado otro.
        const sesion = await bloquearSesion(manager, id);
        const ahora = new Date();
        if (
          sesion?.status === SupportSessionStatus.ACTIVE &&
          sesion.expiresAt &&
          sesion.expiresAt.getTime() <= ahora.getTime()
        ) {
          await transicionar(
            manager,
            sesion,
            AccionDeSoporte.VENCER,
            cierre(SupportEndReason.EXPIRED, null, sesion.expiresAt),
          );
          vencida = sesion;
          return 'expired' as const;
        }
        if (
          sesion?.status === SupportSessionStatus.PENDING &&
          sesion.requestExpiresAt &&
          sesion.requestExpiresAt.getTime() <= ahora.getTime()
        ) {
          await transicionar(manager, sesion, AccionDeSoporte.CADUCAR);
          return 'expiredRequests' as const;
        }
        return null;
      });
      if (cerrada) {
        resultado[cerrada] += 1;
        await this.cache.olvidar(id);
      }
      if (vencida) this.fin.avisar(vencida);
    }
    return resultado;
  }
}
