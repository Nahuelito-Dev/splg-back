import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Not, Repository } from 'typeorm';

import { ZONA_ARGENTINA } from '../common/utils/dias-argentina';
import { ImportJobStatus } from './domain/import.enums';
import { ImportJob } from './entities/import-job.entity';
import { ConRegistro } from '../process-run/process-run.recorder';
import { ProcessName } from '../process-run/domain/process-catalog';

/**
 * Cada vista previa guarda sus filas (hasta 5.000) en `import_job`. Las que nadie
 * confirmó y ya vencieron no sirven para nada: se borran todas las noches. Las
 * confirmadas quedan como historial de qué se importó.
 */
@Injectable()
export class ImportCleanupCron {
  private readonly logger = new Logger(ImportCleanupCron.name);

  constructor(
    @InjectRepository(ImportJob) private readonly jobs: Repository<ImportJob>,
  ) {}

  @Cron('30 3 * * *', { timeZone: ZONA_ARGENTINA })
  @ConRegistro(ProcessName.IMPORT_CLEANUP)
  async borrarVencidas(): Promise<number> {
    const { affected } = await this.jobs.delete({
      status: Not(ImportJobStatus.CONFIRMED),
      expiresAt: LessThan(new Date()),
    });
    const borradas = affected ?? 0;
    if (borradas > 0) {
      this.logger.log(`Se borraron ${borradas} vista(s) previa(s) vencidas`);
    }
    return borradas;
  }
}
