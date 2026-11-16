import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConRegistro } from '../process-run/process-run.recorder';
import {
  erroresAtrapados,
  marcarSaltada,
  registrarErrorAtrapado,
} from '../process-run/process-run.context';
import { EmpresasParaProceso } from '../process-run/empresas-para-proceso';
import { AccesoDeLaEmpresa } from '../platform/access/acceso-de-la-empresa.service';
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
    private readonly redis: RedisService,
    private readonly empresas: EmpresasParaProceso,
    private readonly acceso: AccesoDeLaEmpresa,
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
  /**
   * Con el lector deshabilitado por la plataforma no se arman propuestas
   * nuevas, pero las que ya esperan una decisión siguen su curso hasta vencer
   * (DISENO-PLATAFORMA-ORIXTECH §7.3).
   */
  async ejecutarSinCerrojo(now = new Date()): Promise<void> {
    const { empresas } = await this.empresas.recorrer(
      { proceso: ProcessName.DOCUMENT_READING_PROPOSALS, modulo: null },
      async (distributorId) => {
        if (!(await this.settings.parametros(distributorId)).enabled)
          return false;
        // Sin caché (§6.3): las propuestas nuevas sólo con el lector habilitado ahora.
        const pendientes = (
          await this.acceso.calcular(distributorId)
        ).modulos.has('document_reading')
          ? await this.proposals.procesarPendientesDeDistribuidora(
              distributorId,
              now,
            )
          : 0;
        const vencidas = await this.proposals.vencerDeDistribuidora(
          distributorId,
          now,
        );
        return (
          pendientes > 0 || vencidas.reminders > 0 || vencidas.escalations > 0
        );
      },
    );
    const processed = empresas.some((e) => e.valor === true);
    // Con errores atrapados la corrida no es «saltada»: el monitoreo tiene que verla.
    if (!processed && erroresAtrapados() === 0) marcarSaltada();
  }
}
