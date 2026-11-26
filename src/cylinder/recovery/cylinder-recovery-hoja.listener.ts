import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { errorMessage } from '../../common/errors/error-message';
import {
  EVENTO_HOJA_EN_CURSO,
  type HojaEnCurso,
} from '../../route-batch/domain/events/hoja-en-curso.event';
import { CylinderRecoveryPickupOpportunityService } from './cylinder-recovery-pickup-opportunity.service';

/**
 * M5b: al iniciarse una hoja de ruta y en cada pasada del seguimiento de hojas se
 * buscan los envases sin devolver que se pueden retirar aprovechando el viaje.
 * Es best-effort: si falla, la pasada siguiente (cada minuto) lo reintenta.
 */
@Injectable()
export class CylinderRecoveryHojaListener {
  private readonly logger = new Logger(CylinderRecoveryHojaListener.name);

  constructor(
    private readonly retiros: CylinderRecoveryPickupOpportunityService,
  ) {}

  @OnEvent(EVENTO_HOJA_EN_CURSO, { async: true })
  async alHaberHojaEnCurso(evento: HojaEnCurso): Promise<void> {
    try {
      await this.retiros.ofrecer(evento.distributorId, evento.batchId);
    } catch (error) {
      this.logger.warn(
        `No se pudo ofrecer retiros aprovechando la hoja: ${errorMessage(error)}`,
      );
    }
  }
}
