import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { errorMessage } from '../../common/errors/error-message';
import { ProcessName } from '../../process-run/domain/process-catalog';
import {
  marcarSaltada,
  registrarElementoBien,
  registrarErrorAtrapado,
  registrarFallaDeElemento,
} from '../../process-run/process-run.context';
import { ConRegistro } from '../../process-run/process-run.recorder';
import { RedisService } from '../../redis/redis.service';
import { EscaneoDeAdjuntos } from './escaneo-de-adjuntos';

/** Esperas entre intentos dentro de la tarea (más cortas: corre con cerrojo de un minuto). */
export const ESPERAS_DE_LA_TAREA_MS: readonly number[] = [500, 1_500];

/**
 * Cada minuto (una sola instancia, con cerrojo): retoma los escaneos de
 * adjuntos del chat que quedaron pendientes porque el back se reinició antes
 * de terminarlos (§9.3). Aparece en el monitoreo como `chat_attachment_scan`.
 */
@Injectable()
export class EscaneoDeAdjuntosCron {
  static readonly CERROJO = 'cron:chat-attachment-scan';
  static readonly CERROJO_TTL_MS = 55_000;

  private readonly logger = new Logger(EscaneoDeAdjuntosCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly escaneo: EscaneoDeAdjuntos,
  ) {}

  @Cron('20 * * * * *')
  @ConRegistro(ProcessName.CHAT_ATTACHMENT_SCAN)
  async retomar(): Promise<{ scanned: number } | undefined> {
    try {
      const bloqueo = await this.redis.withLock(
        EscaneoDeAdjuntosCron.CERROJO,
        EscaneoDeAdjuntosCron.CERROJO_TTL_MS,
        () => this.barrer(new Date()),
      );
      if (bloqueo.obtenido) return bloqueo.valor;
      marcarSaltada();
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error(
        `Antivirus del chat: la ejecución falló: ${errorMessage(error)}`,
      );
    }
    return undefined;
  }

  /** Escanea los olvidados de a uno (tres intentos, con esperas cortas); el que falla no frena al resto. */
  async barrer(ahora: Date): Promise<{ scanned: number }> {
    let scanned = 0;
    for (const id of await this.escaneo.olvidados(ahora)) {
      try {
        if (await this.escaneo.escanear(id, ESPERAS_DE_LA_TAREA_MS)) {
          scanned += 1;
        }
        registrarElementoBien(`adjunto:${id}`);
      } catch (error) {
        registrarFallaDeElemento(`adjunto:${id}`, error);
        this.logger.error(
          `Antivirus del chat: falló el adjunto ${id}: ${errorMessage(error)}`,
        );
      }
    }
    return { scanned };
  }
}
