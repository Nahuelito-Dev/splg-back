import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { EntityManager, LessThanOrEqual, Repository } from 'typeorm';
import { S3Service } from './s3.service';
import {
  StorageOrphan,
  StorageOrphanKind,
  StorageOrphanStatus,
} from './entities/storage-orphan.entity';
import { errorMessage } from '../common/errors/error-message';

/** Esperas entre intentos de borrado en proceso (backoff): 1 s, 5 s y 30 s. */
export const REMOVE_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000];

/** Intentos totales (en proceso + cron) antes de darla por fallida. */
export const MAX_ORPHAN_ATTEMPTS = 24;

/** Una subida reservada y no confirmada en este tiempo se considera abandonada. */
export const UPLOAD_GRACE_MS = 60 * 60 * 1000;

/** Cuántos huérfanos toma cada corrida del cron. */
const ORPHANS_PER_RUN = 100;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Evita objetos sin dueño en el bucket, sin bloquear la respuesta HTTP: se
 * registra la INTENCIÓN antes de la operación que puede dejar basura.
 *
 * - Borrar/reemplazar: `scheduleRemoval(manager, key)` anota la key en la MISMA
 *   transacción que borra o reemplaza la referencia; después de confirmar,
 *   `removeInBackground(key)` intenta el borrado y, si sale, quita la fila.
 * - Subir: `reserveUpload(key)` anota la key ANTES del `put`; la transacción que
 *   guarda la referencia la confirma con `confirmUpload(manager, key)` (quita la
 *   fila). Si el proceso cae entre el `put` y el commit, la fila queda y el
 *   cron borra el objeto pasada la hora de gracia: como la confirmación va en
 *   la misma transacción que la referencia, una fila vieja significa que la
 *   referencia nunca existió.
 * - El cron horario reintenta lo pendiente con backoff creciente; tras
 *   `MAX_ORPHAN_ATTEMPTS` la marca como fallida y lo deja en el log.
 */
@Injectable()
export class S3CleanupService {
  private readonly logger = new Logger(S3CleanupService.name);

  constructor(
    private readonly s3: S3Service,
    @InjectRepository(StorageOrphan)
    private readonly orphans: Repository<StorageOrphan>,
  ) {}

  /** Reserva la key antes de subir. Si no se puede anotar, no se sube. */
  async reserveUpload(key: string): Promise<void> {
    await this.orphans.upsert(
      {
        storageKey: key,
        kind: StorageOrphanKind.UPLOAD,
        status: StorageOrphanStatus.PENDING,
        nextAttemptAt: new Date(Date.now() + UPLOAD_GRACE_MS),
      },
      ['storageKey'],
    );
  }

  /** Confirma la subida en la transacción que guarda la referencia. */
  async confirmUpload(manager: EntityManager, key: string): Promise<void> {
    await manager.delete(StorageOrphan, { storageKey: key });
  }

  /** Anota el borrado en la misma transacción que quita la referencia. */
  async scheduleRemoval(manager: EntityManager, key: string): Promise<void> {
    await manager.upsert(
      StorageOrphan,
      {
        storageKey: key,
        kind: StorageOrphanKind.REMOVE,
        status: StorageOrphanStatus.PENDING,
        nextAttemptAt: new Date(),
      },
      ['storageKey'],
    );
  }

  /** Dispara el borrado y vuelve sin esperar. Nunca lanza. */
  removeInBackground(key: string): void {
    void this.removeWithRetry(key);
  }

  /** Cuerpo del borrado en segundo plano; se exporta para poder esperarlo en tests. */
  async removeWithRetry(key: string): Promise<void> {
    for (let attempt = 0; attempt <= REMOVE_RETRY_DELAYS_MS.length; attempt++) {
      try {
        await this.s3.remove(key);
        await this.forget(key);
        return;
      } catch (error) {
        this.logger.warn(
          `No se pudo borrar ${key} del bucket (intento ${attempt + 1}): ${errorMessage(error)}`,
        );
        if (attempt < REMOVE_RETRY_DELAYS_MS.length) {
          await this.sleep(REMOVE_RETRY_DELAYS_MS[attempt]);
        }
      }
    }
    this.logger.error(
      `${key} sigue en el bucket tras los reintentos; el cron lo va a reintentar`,
    );
    await this.registerFailure(key, 'borrado en segundo plano agotado');
  }

  /** Reintenta lo pendiente cuyo turno ya llegó, de a tandas y por orden de turno. */
  @Cron('0 * * * *')
  async retryOrphans(): Promise<void> {
    const due = await this.orphans.find({
      where: {
        status: StorageOrphanStatus.PENDING,
        nextAttemptAt: LessThanOrEqual(new Date()),
      },
      order: { nextAttemptAt: 'ASC' },
      take: ORPHANS_PER_RUN,
    });
    for (const orphan of due) {
      try {
        await this.s3.remove(orphan.storageKey);
        await this.orphans.delete({ orphanId: orphan.orphanId });
      } catch (error) {
        const reason = errorMessage(error);
        this.logger.warn(
          `Reintento fallido de ${orphan.storageKey} (intento ${orphan.attempts + 1}): ${reason}`,
        );
        await this.bump(orphan, reason);
      }
    }
  }

  /** Suma un intento fallido: backoff creciente, o fallida definitiva al tope. */
  private async bump(orphan: StorageOrphan, reason: string): Promise<void> {
    orphan.attempts += 1;
    orphan.lastError = reason;
    if (orphan.attempts >= MAX_ORPHAN_ATTEMPTS) {
      orphan.status = StorageOrphanStatus.FAILED;
      this.logger.error(
        `Huérfano FALLIDO tras ${orphan.attempts} intentos, hay que borrarlo a mano: ${orphan.storageKey} (${reason})`,
      );
    } else {
      // 1 h, 2 h, 3 h... con tope de 24 h.
      const hours = Math.min(orphan.attempts, 24);
      orphan.nextAttemptAt = new Date(Date.now() + hours * HOUR_MS);
    }
    try {
      await this.orphans.save(orphan);
    } catch (error) {
      this.logger.error(
        `No se pudo actualizar el huérfano ${orphan.storageKey}: ${errorMessage(error)}`,
      );
    }
  }

  /** El borrado salió: la fila (si había) ya no hace falta. */
  private async forget(key: string): Promise<void> {
    try {
      await this.orphans.delete({ storageKey: key });
    } catch (error) {
      this.logger.error(
        `No se pudo sacar ${key} de los huérfanos: ${errorMessage(error)}`,
      );
    }
  }

  /** Deja la fila lista para el cron (la crea si el caller no la había anotado). */
  private async registerFailure(key: string, reason: string): Promise<void> {
    try {
      const existing = await this.orphans.findOne({
        where: { storageKey: key },
      });
      if (existing) {
        await this.bump(existing, reason);
        return;
      }
      await this.orphans.save(
        this.orphans.create({
          storageKey: key,
          kind: StorageOrphanKind.REMOVE,
          status: StorageOrphanStatus.PENDING,
          attempts: 1,
          lastError: reason,
          nextAttemptAt: new Date(Date.now() + HOUR_MS),
        }),
      );
    } catch (error) {
      this.logger.error(
        `No se pudo registrar el huérfano ${key}: ${errorMessage(error)}`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
