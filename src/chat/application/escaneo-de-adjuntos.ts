import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { AttachmentScanStatus } from '../../attachment/attachment-scan-status';
import {
  Attachment,
  AttachmentOwnerType,
} from '../../attachment/entities/attachment.entity';
import {
  EscanerDeArchivos,
  type ResultadoDelEscaneo,
} from '../../attachment/escaner/escaner-de-archivos.port';
import { pedirAvisoAlAdmin } from '../../common/events/aviso-al-admin';
import {
  EVENTO_NOTIFICAR_ADMIN,
  NotificarAdminEvent,
} from '../../common/events/notificar-admin.event';
import { errorMessage } from '../../common/errors/error-message';
import { S3CleanupService } from '../../s3/s3-cleanup.service';
import { S3Service } from '../../s3/s3.service';
import { Semaforo } from '../../s3/limpiar-imagen';
import {
  ESCANEOS_SIMULTANEOS,
  estadoTrasEscanear,
  MAX_INTENTOS_DE_ESCANEO,
} from '../domain/adjuntos';
import { esCanalDeLaBandeja, Party } from '../domain/chat.enums';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { ChatEvents, Efectos } from './chat.events';

/** Esperas entre los intentos de escaneo: tres intentos en total (§9.3). */
export const ESPERAS_ENTRE_INTENTOS_MS: readonly number[] = [2_000, 10_000];

/** Un `failed` se reintenta pasado este rato desde el último intento. */
export const ESPERA_PARA_REINTENTAR_MS = 5 * 60_000;

/** A lo sumo `ESCANEOS_SIMULTANEOS` escaneos a la vez por proceso (memoria y clamd). */
const semaforo = new Semaforo(ESCANEOS_SIMULTANEOS);

/** Un escaneo pendiente más viejo que esto lo retoma la tarea programada (el del commit se perdió). */
export const PENDIENTE_OLVIDADO_MS = 2 * 60_000;

/** Aviso del panel: se bloqueó un archivo con virus. */
export const AVISO_ADJUNTO_BLOQUEADO = 'chat_attachment_blocked';

const dormir = (ms: number) =>
  new Promise<void>((resolver) => setTimeout(resolver, ms));

/**
 * El antivirus de los adjuntos del chat (§9.3, D-C15). Después del commit de
 * la subida, en segundo plano: baja el archivo de S3, lo pasa por el escáner
 * (hasta 3 intentos por pasada, a lo sumo `ESCANEOS_SIMULTANEOS` a la vez) y
 * deja el adjunto `clean`, `infected` o `failed` (sólo si seguía `pending` o
 * `failed`: un `infected` gana sobre un `failed` de otra pasada y nada pisa un
 * resultado). `failed` no es final: la tarea programada lo reintenta hasta
 * `MAX_INTENTOS_DE_ESCANEO`, y mientras tanto nadie lo baja. Las salas de la
 * conversación reciben el mensaje otra vez (`chat:message`) para refrescar el
 * estado.
 *
 * Infectado: el adjunto queda oculto (la descarga da 404), la key va a
 * `storage_orphan` para que se borre el objeto, y avisan a la empresa (y a la
 * plataforma, si es el chat de soporte) y a quien lo subió si es del personal.
 * El cliente y el chofer se enteran por el mensaje actualizado.
 */
@Injectable()
export class EscaneoDeAdjuntos {
  private readonly logger = new Logger(EscaneoDeAdjuntos.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: S3Service,
    private readonly cleanup: S3CleanupService,
    private readonly escaner: EscanerDeArchivos,
    private readonly eventos: ChatEvents,
    private readonly avisos: EventEmitter2,
  ) {}

  /** Escanea en segundo plano, sin demorar la respuesta de la subida. Nunca lanza. */
  encolar(attachmentId: string): void {
    setImmediate(() => {
      this.escanear(attachmentId).catch((error: unknown) => {
        this.logger.error(
          `No se pudo escanear el adjunto ${attachmentId}: ${errorMessage(error)}`,
        );
      });
    });
  }

  /**
   * Escanea un adjunto `pending` (o `failed` que todavía tiene intentos) y
   * deja su estado. Devuelve el estado o `null` si no había nada que hacer:
   * dado de baja, ya resuelto (por otra pasada) o sin intentos.
   */
  async escanear(
    attachmentId: string,
    esperas: readonly number[] = ESPERAS_ENTRE_INTENTOS_MS,
  ): Promise<AttachmentScanStatus | null> {
    // `findOne` no trae los dados de baja (`deleted_at`).
    const a = await this.dataSource.getRepository(Attachment).findOne({
      where: {
        attachmentId,
        ownerType: AttachmentOwnerType.CHAT_MESSAGE,
        scanStatus: In([
          AttachmentScanStatus.PENDING,
          AttachmentScanStatus.FAILED,
        ]),
      },
    });
    if (
      !a ||
      estadoTrasEscanear(a.scanStatus, AttachmentScanStatus.CLEAN) === null ||
      a.scanAttempts >= MAX_INTENTOS_DE_ESCANEO
    ) {
      return null;
    }
    const { resultado, intentos } = await semaforo.correr(() =>
      this.conReintentos(a, esperas),
    );
    const estado =
      resultado === null
        ? AttachmentScanStatus.FAILED
        : resultado.infectado
          ? AttachmentScanStatus.INFECTED
          : AttachmentScanStatus.CLEAN;

    const efectos = new Efectos();
    const cambio = await this.dataSource.transaction(async (manager) => {
      // Sólo sobre lo que sigue `pending` o `failed` y vigente: un
      // `infected` pisa un `failed` de otra pasada; nada pisa un resultado.
      const filas: unknown = await manager.query(
        `UPDATE "attachment"
            SET "scan_status" = $2, "scanned_at" = now(),
                "scan_attempts" = LEAST("scan_attempts" + $3, 50)
          WHERE "attachment_id" = $1 AND "scan_status" IN ('pending', 'failed')
            AND "deleted_at" IS NULL
          RETURNING "attachment_id"`,
        [a.attachmentId, estado, intentos],
      );
      if (!huboFilas(filas)) return null;
      if (estado === AttachmentScanStatus.INFECTED) {
        await this.cleanup.scheduleRemoval(manager, a.storageKey);
      }
      const message = await manager
        .getRepository(Message)
        .findOne({ where: { messageId: a.messageId as string } });
      const conversation = message
        ? await manager.getRepository(Conversation).findOne({
            where: { conversationId: message.conversationId },
          })
        : null;
      if (message && conversation) {
        efectos.actualizacion(conversation, message);
      }
      return { message, conversation };
    });
    if (!cambio) return null;
    this.eventos.publicar(efectos);
    if (
      estado === AttachmentScanStatus.INFECTED &&
      cambio.message &&
      cambio.conversation
    ) {
      this.avisarInfectado(a, cambio.message, cambio.conversation);
    }
    return estado;
  }

  /**
   * Lo que la tarea programada tiene que (re)escanear, los más viejos
   * primero: los `pending` que nadie terminó (se perdió el escaneo del
   * commit) y los `failed` con intentos, pasado un rato del último. Nunca los
   * dados de baja.
   */
  async olvidados(ahora: Date, limite = 20): Promise<string[]> {
    const filas: Array<{ attachment_id: string }> = await this.dataSource.query(
      `SELECT "attachment_id" FROM "attachment"
        WHERE "deleted_at" IS NULL AND "message_id" IS NOT NULL
          AND (("scan_status" = 'pending' AND "uploaded_at" < $1)
               OR ("scan_status" = 'failed' AND "scan_attempts" < $3
                   AND "scanned_at" < $4))
        ORDER BY "uploaded_at" LIMIT $2`,
      [
        new Date(ahora.getTime() - PENDIENTE_OLVIDADO_MS),
        limite,
        MAX_INTENTOS_DE_ESCANEO,
        new Date(ahora.getTime() - ESPERA_PARA_REINTENTAR_MS),
      ],
    );
    return filas.map((f) => f.attachment_id);
  }

  private async conReintentos(
    a: Attachment,
    esperas: readonly number[],
  ): Promise<{ resultado: ResultadoDelEscaneo | null; intentos: number }> {
    for (let intento = 0; intento <= esperas.length; intento++) {
      try {
        const contenido = await this.storage.get(a.storageKey);
        const resultado = await this.escaner.escanear(contenido);
        if (resultado.infectado) {
          this.logger.warn(
            `${this.escaner.nombre} encontró «${resultado.firma}» en el adjunto ${a.attachmentId} de la distribuidora ${a.distributorId}`,
          );
        }
        return { resultado, intentos: intento + 1 };
      } catch (error) {
        this.logger.warn(
          `Escaneo del adjunto ${a.attachmentId}, intento ${intento + 1}: ${errorMessage(error)}`,
        );
        if (intento < esperas.length) await dormir(esperas[intento]);
      }
    }
    this.logger.error(
      `El adjunto ${a.attachmentId} de la distribuidora ${a.distributorId} no se pudo escanear: queda como no verificado (se reintenta)`,
    );
    return { resultado: null, intentos: esperas.length + 1 };
  }

  private avisarInfectado(a: Attachment, m: Message, c: Conversation): void {
    const titulo = 'Bloqueamos un archivo con virus en el chat';
    const texto = `«${a.originalName}» tenía un virus: no se puede abrir ni bajar y se va a borrar.`;
    const clave = `chat-attachment-infected:${a.attachmentId}`;
    const bandeja = esCanalDeLaBandeja(c.channel);
    pedirAvisoAlAdmin(this.avisos, this.logger, {
      distributorId: c.distributorId,
      kind: AVISO_ADJUNTO_BLOQUEADO,
      title: titulo,
      body: texto,
      link: bandeja ? { entity: 'conversation', id: c.conversationId } : null,
      dedupeKey: clave,
    });
    if (!bandeja) {
      pedirAvisoAlAdmin(this.avisos, this.logger, {
        distributorId: null,
        kind: AVISO_ADJUNTO_BLOQUEADO,
        title: titulo,
        body: texto,
        link: null,
        dedupeKey: `${clave}:plataforma`,
      });
    }
    if (m.senderParty !== Party.COMPANY) return;
    try {
      this.avisos.emit(
        EVENTO_NOTIFICAR_ADMIN,
        new NotificarAdminEvent(
          c.distributorId,
          AVISO_ADJUNTO_BLOQUEADO,
          'Bloqueamos un archivo que mandaste',
          texto,
          bandeja ? { entity: 'conversation', id: c.conversationId } : null,
          false,
          `${clave}:autor`,
          undefined,
          a.uploadedByUserId,
        ),
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo avisar a quien subió el adjunto ${a.attachmentId}: ${errorMessage(error)}`,
      );
    }
  }
}

/** Un `UPDATE ... RETURNING` de Postgres devuelve `[filas, cantidad]`. */
function huboFilas(resultado: unknown): boolean {
  if (!Array.isArray(resultado)) return false;
  const filas: unknown = Array.isArray(resultado[0]) ? resultado[0] : resultado;
  return Array.isArray(filas) && filas.length > 0;
}
