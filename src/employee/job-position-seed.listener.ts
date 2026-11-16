import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { JobPositionService } from './job-position.service';
import {
  DistribuidoraCreadaEvent,
  EVENTO_DISTRIBUIDORA_CREADA,
} from '../distributor/events/distribuidora-creada.event';

/**
 * Siembra los puestos base (Chofer, Ayudante, Depósito, Administración y
 * Vendedor) cuando se da de alta una distribuidora, igual que
 * `FleetPlanSeedListener` con los planes de flota: así `distributor` no
 * depende de `employee` (CONVENCIONES §4). Las distribuidoras anteriores las
 * siembra la migración `SembrarPuestosDeTrabajo`. Es idempotente.
 */
@Injectable()
export class JobPositionSeedListener {
  private readonly logger = new Logger(JobPositionSeedListener.name);

  constructor(private readonly positions: JobPositionService) {}

  @OnEvent(EVENTO_DISTRIBUIDORA_CREADA)
  async handle(evento: DistribuidoraCreadaEvent): Promise<void> {
    const sembrados = await this.positions.sembrarBase(evento.distributorId);
    if (sembrados > 0) {
      this.logger.log(
        `Sembrados ${sembrados} puestos base para la distribuidora ${evento.distributorId}`,
      );
    }
  }
}
