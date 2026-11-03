import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

import { codigoSqlDelError } from '../../common/errors/db-exceptions';
import { errorMessage } from '../../common/errors/error-message';
import { pedirAvisoAlAdmin } from '../../common/events/aviso-al-admin';
import {
  EVENTO_PAGO_NOTIFICADO,
  PagoNotificadoEvent,
} from '../domain/events/pago-notificado.event';
import {
  EstadoDelAvisoGuardado,
  PaymentNotificationInbox,
} from '../entities/payment-notification-inbox.entity';
import { Payment } from '../entities/payment.entity';
import { ConRegistro } from '../../process-run/process-run.recorder';
import { conDisparo } from '../../process-run/process-run.context';
import { registrarErrorAtrapado } from '../../process-run/process-run.context';
import {
  ProcessName,
  RunTrigger,
} from '../../process-run/domain/process-catalog';

export interface AvisoParaGuardar {
  type: string;
  dataId: string;
  credentialId?: string | null;
  rawBody?: Record<string, unknown> | null;
}

/**
 * Procesa los avisos guardados en la bandeja de entrada (ver
 * `PaymentNotificationInbox`) con reintentos propios y espera creciente. Corre cada
 * 30 segundos y se dispara también apenas se guarda un aviso.
 */
@Injectable()
export class PaymentNotificationInboxService {
  private readonly logger = new Logger(PaymentNotificationInboxService.name);

  /** Intentos propios antes de dar el aviso por fallido y avisar al administrador. */
  static readonly INTENTOS_MAXIMOS = 8;
  /** Espera tras el primer fallo; se duplica en cada intento hasta el tope. */
  static readonly ESPERA_BASE_MS = 30_000;
  static readonly ESPERA_MAXIMA_MS = 30 * 60_000;
  static readonly LOTE = 20;
  /** 0 = no se purga nada (borrado lógico: los avisos se conservan). Sólo se purga si se configura explícitamente. */
  static readonly RETENCION_POR_DEFECTO_DIAS = 0;

  constructor(
    @InjectRepository(PaymentNotificationInbox)
    private readonly bandeja: Repository<PaymentNotificationInbox>,
    @InjectRepository(Payment)
    private readonly pagos: Repository<Payment>,
    private readonly eventos: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

  /** Guarda el aviso crudo. Idempotente: el mismo aviso (tipo y recurso) no se guarda dos veces. Lanza si no se pudo guardar. */
  async guardar(aviso: AvisoParaGuardar): Promise<void> {
    try {
      await this.bandeja.save(
        this.bandeja.create({
          type: aviso.type,
          dataId: aviso.dataId,
          credentialId: aviso.credentialId ?? null,
          rawBody: aviso.rawBody ?? null,
        }),
      );
    } catch (error) {
      // El mismo aviso otra vez (único por tipo y recurso): ya está guardado.
      if (codigoSqlDelError(error) !== '23505') throw error;
    }
  }

  /** Procesa ya, sin esperar, lo que acaba de guardarse. Nunca lanza: los reintentos son del cron. */
  procesarEnSegundoPlano(): void {
    void conDisparo(RunTrigger.WEBHOOK, () => this.procesarPendientes()).catch(
      (error: unknown) =>
        this.logger.error(
          `No se pudo procesar la bandeja de avisos: ${errorMessage(error)}`,
        ),
    );
  }

  @Cron('15,45 * * * * *')
  @ConRegistro(ProcessName.PAYMENT_INBOX_PROCESS)
  async procesarPendientes(): Promise<number> {
    const tomados = await this.tomarLote();
    let procesados = 0;
    for (const aviso of tomados) {
      try {
        await this.eventos.emitAsync(
          EVENTO_PAGO_NOTIFICADO,
          new PagoNotificadoEvent(
            aviso.type,
            aviso.dataId,
            undefined,
            undefined,
            aviso.credentialId ?? undefined,
          ),
        );
        await this.bandeja.update(
          { notificationId: aviso.notificationId },
          {
            status: EstadoDelAvisoGuardado.PROCESSED,
            processedAt: new Date(),
            lastError: null,
          },
        );
        procesados++;
      } catch (error) {
        registrarErrorAtrapado(error);
        await this.registrarFallo(aviso, error);
      }
    }
    return procesados;
  }

  /**
   * Toma los pendientes cuyo turno llegó y les corre el turno (`next_attempt_at`) para
   * que otra instancia no los tome a la vez (`FOR UPDATE SKIP LOCKED`).
   */
  private async tomarLote(): Promise<PaymentNotificationInbox[]> {
    const filas: Array<Record<string, unknown>> = await this.bandeja.query(
      `UPDATE "payment_notification_inbox" SET "next_attempt_at" = now() + interval '60 seconds',
         "attempts" = "attempts" + 1
       WHERE "notification_id" IN (
         SELECT "notification_id" FROM "payment_notification_inbox"
         WHERE "status" = 'pending' AND "next_attempt_at" <= now()
         ORDER BY "createdAt" LIMIT ${PaymentNotificationInboxService.LOTE}
         FOR UPDATE SKIP LOCKED)
       RETURNING "notification_id", "type", "data_id", "credential_id", "attempts"`,
    );
    // Un UPDATE ... RETURNING de TypeORM trae [filas, cantidad].
    const lista = (Array.isArray(filas[0]) ? filas[0] : filas) as Array<
      Record<string, unknown>
    >;
    return lista.map(
      (f) =>
        ({
          notificationId: f.notification_id,
          type: f.type,
          dataId: f.data_id,
          credentialId: f.credential_id ?? null,
          attempts: Number(f.attempts),
        }) as PaymentNotificationInbox,
    );
  }

  private async registrarFallo(
    aviso: PaymentNotificationInbox,
    error: unknown,
  ): Promise<void> {
    // `attempts` ya viene incrementado por la toma del lote (en SQL, bajo el lock).
    const intentos = aviso.attempts;
    const agotado =
      intentos >= PaymentNotificationInboxService.INTENTOS_MAXIMOS;
    const espera = Math.min(
      PaymentNotificationInboxService.ESPERA_BASE_MS * 2 ** (intentos - 1),
      PaymentNotificationInboxService.ESPERA_MAXIMA_MS,
    );
    this.logger.error(
      `Aviso ${aviso.type}:${aviso.dataId} sin procesar (intento ${intentos}): ${errorMessage(error)}`,
    );
    await this.bandeja.update(
      { notificationId: aviso.notificationId },
      {
        lastError: errorMessage(error).slice(0, 500),
        nextAttemptAt: new Date(Date.now() + espera),
        ...(agotado && { status: EstadoDelAvisoGuardado.FAILED }),
      },
    );
    if (agotado) await this.avisarAlAdmin(aviso);
  }

  /**
   * Por omisión no borra nada: el sistema no elimina filas (borrado lógico) y los avisos de Mercado
   * Pago son poco volumen. Sólo si se configura `PAYMENT_INBOX_RETENTION_DAYS` (7 o más), una vez por
   * día borra los procesados de más de esos días. Los `failed` NO se purgan nunca: son la evidencia
   * (`raw_body` y `credential_id`) de una alerta que el sistema no pudo procesar.
   */
  @Cron('0 20 4 * * *')
  @ConRegistro(ProcessName.PAYMENT_INBOX_PURGE)
  async purgarProcesados(): Promise<number> {
    const dias = this.config.get<number>(
      'PAYMENT_INBOX_RETENTION_DAYS',
      PaymentNotificationInboxService.RETENCION_POR_DEFECTO_DIAS,
    );
    if (!dias || dias <= 0) return 0;
    const corte = new Date(Date.now() - dias * 24 * 3600 * 1000);
    const r = await this.bandeja.delete({
      status: EstadoDelAvisoGuardado.PROCESSED,
      processedAt: LessThan(corte),
    });
    return r.affected ?? 0;
  }

  /** La alerta no se pudo procesar tras todos los intentos: el administrador la mira a mano en Mercado Pago. */
  private async avisarAlAdmin(aviso: PaymentNotificationInbox): Promise<void> {
    let distributorId: string | null = null;
    try {
      const pago = await this.pagos.findOne({
        where: { gatewayPaymentId: aviso.dataId },
        select: { paymentId: true, distributorId: true, orderId: true },
      });
      distributorId = pago?.distributorId ?? null;
      if (!distributorId) {
        this.logger.error(
          `Alerta ${aviso.type} del pago ${aviso.dataId} sin procesar y sin distribuidora a quién avisar: revisarla en Mercado Pago`,
        );
        return;
      }
      pedirAvisoAlAdmin(this.eventos, this.logger, {
        distributorId,
        kind: 'payment_alert_unprocessed',
        title: 'Alerta de Mercado Pago sin procesar',
        body: `Mercado Pago avisó una alerta (${aviso.type}) sobre el pago ${aviso.dataId} y el sistema no pudo procesarla tras varios intentos. Revisá el pago en Mercado Pago: si es una alerta de fraude, no entregues el pedido.`,
        link: pago?.orderId ? { entity: 'order', id: pago.orderId } : null,
        dedupeKey: `mp-alerta-sin-procesar:${aviso.type}:${aviso.dataId}`,
        email: true,
      });
    } catch (error) {
      registrarErrorAtrapado(error);
      this.logger.error(
        `No se pudo avisar la alerta ${aviso.dataId} sin procesar: ${errorMessage(error)}`,
      );
    }
  }
}
