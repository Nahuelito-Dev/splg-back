import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributorService } from '../distributor/distributor.service';
import { DistributorStatus } from '../distributor/entities/distributor.entity';
import { RedisService } from '../redis/redis.service';
import { ConRegistro } from '../process-run/process-run.recorder';
import {
  marcarSaltada,
  registrarErrorAtrapado,
} from '../process-run/process-run.context';
import { ProcessName } from '../process-run/domain/process-catalog';
import { DocumentReadingSettingsService } from './document-reading-settings.service';
import {
  DocumentReadingRunnerService,
  DocumentReadingRunResult,
} from './document-reading-runner.service';

@Injectable()
export class DocumentReadingCron {
  private readonly logger = new Logger(DocumentReadingCron.name);
  static readonly LOCK = 'cron:document-reading';
  constructor(
    private readonly runner: DocumentReadingRunnerService,
    private readonly settings: DocumentReadingSettingsService,
    private readonly distributors: DistributorService,
    private readonly redis: RedisService,
  ) {}
  @Cron('0 * * * * *')
  @ConRegistro(ProcessName.DOCUMENT_READING)
  async ejecutar(): Promise<DocumentReadingRunResult | undefined> {
    try {
      const lock = await this.redis.withLock(
        DocumentReadingCron.LOCK,
        55_000,
        () => this.ejecutarSinCerrojo(),
      );
      if (lock.obtenido) return lock.valor;
      marcarSaltada();
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error('Lectura automática falló');
    }
  }
  async ejecutarSinCerrojo(
    ahora = new Date(),
  ): Promise<DocumentReadingRunResult> {
    if (!this.runner.disponible) {
      marcarSaltada();
      return {
        distributors: 0,
        read: 0,
        duplicates: 0,
        failed: 0,
        skipped: 0,
        budgetReached: 0,
      };
    }
    const total: DocumentReadingRunResult = {
      distributors: 0,
      read: 0,
      duplicates: 0,
      failed: 0,
      skipped: 0,
      budgetReached: 0,
    };
    for (const distributor of await this.distributors.findAll()) {
      if (distributor.status !== DistributorStatus.ACTIVE) continue;
      try {
        const settings = await this.settings.parametros(
          distributor.distributorId,
        );
        if (!settings.enabled) continue;
        const key = `document-reading:ultima:${distributor.distributorId}`;
        const previous = await this.redis.get(key);
        if (
          previous &&
          ahora.getTime() - Number(previous) <
            settings.frequencyMinutes * 60_000
        )
          continue;
        const result = await this.runner.run(distributor.distributorId);
        await this.redis.setex(key, 31 * 24 * 60 * 60, String(ahora.getTime()));
        for (const key of Object.keys(
          total,
        ) as (keyof DocumentReadingRunResult)[])
          total[key] += result[key];
      } catch (error) {
        // «Correr ahora» de esa distribuidora está en curso: le toca en la próxima.
        if (error instanceof ConflictException) continue;
        registrarErrorAtrapado(error);
        this.logger.error(
          `Lectura automática ${distributor.distributorId}: ${String(error)}`,
        );
      }
    }
    if (total.distributors === 0) marcarSaltada();
    return total;
  }
}
