import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributorService } from '../distributor/distributor.service';
import { DistributorStatus } from '../distributor/entities/distributor.entity';
import { ConRegistro } from '../process-run/process-run.recorder';
import {
  erroresAtrapados,
  marcarSaltada,
  registrarErrorAtrapado,
} from '../process-run/process-run.context';
import { ProcessName } from '../process-run/domain/process-catalog';
import { RedisService } from '../redis/redis.service';
import { DocumentReadingSettingsService } from './document-reading-settings.service';
import { DocumentReadingProposalService } from './document-reading-proposal.service';

@Injectable()
export class DocumentReadingProposalCron {
  private readonly logger = new Logger(DocumentReadingProposalCron.name);
  static readonly LOCK = 'cron:document-reading-proposals';
  constructor(
    private readonly proposals: DocumentReadingProposalService,
    private readonly settings: DocumentReadingSettingsService,
    private readonly distributors: DistributorService,
    private readonly redis: RedisService,
  ) {}
  @Cron('0 */5 * * * *')
  @ConRegistro(ProcessName.DOCUMENT_READING_PROPOSALS)
  async ejecutar(): Promise<void> {
    try {
      const lock = await this.redis.withLock(
        DocumentReadingProposalCron.LOCK,
        295_000,
        () => this.ejecutarSinCerrojo(),
      );
      if (!lock.obtenido) marcarSaltada();
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error('Vencimiento de propuestas de documentos falló');
    }
  }
  async ejecutarSinCerrojo(now = new Date()): Promise<void> {
    let processed = false;
    for (const distributor of await this.distributors.findAll()) {
      if (distributor.status !== DistributorStatus.ACTIVE) continue;
      try {
        if (
          !(await this.settings.parametros(distributor.distributorId)).enabled
        )
          continue;
        const pendientes =
          await this.proposals.procesarPendientesDeDistribuidora(
            distributor.distributorId,
            now,
          );
        const vencidas = await this.proposals.vencerDeDistribuidora(
          distributor.distributorId,
          now,
        );
        processed ||=
          pendientes > 0 || vencidas.reminders > 0 || vencidas.escalations > 0;
      } catch (error) {
        registrarErrorAtrapado(error);
        this.logger.error(
          `Vencimiento de propuestas ${distributor.distributorId}: ${String(error)}`,
        );
      }
    }
    // Con errores atrapados la corrida no es «saltada»: el monitoreo tiene que verla.
    if (!processed && erroresAtrapados() === 0) marcarSaltada();
  }
}
