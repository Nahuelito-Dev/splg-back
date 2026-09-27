import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { MaintenancePlan } from './entities/maintenance-plan.entity';
import { BASE_PLAN_DEFINITIONS } from './domain/base-plans';
import {
  DistribuidoraCreadaEvent,
  EVENTO_DISTRIBUIDORA_CREADA,
} from '../distributor/events/distribuidora-creada.event';

/**
 * Siembra los planes base de flota (seguro, VTV, licencia, service) cuando se
 * da de alta una distribuidora. Escucha el evento en vez de que
 * `DistributorService.create` llame a `fleet` directo (CONVENCIONES §4): así
 * `distributor` no depende de `fleet`.
 *
 * Las distribuidoras que ya existían antes de este módulo las siembra la
 * migración `SembrarPlanesBaseDeFlota` (backfill, una sola vez). Este listener
 * es idempotente igual: si por lo que sea ya tiene planes, no hace nada.
 */
@Injectable()
export class FleetPlanSeedListener {
  private readonly logger = new Logger(FleetPlanSeedListener.name);

  constructor(
    @InjectRepository(MaintenancePlan)
    private readonly plans: Repository<MaintenancePlan>,
  ) {}

  @OnEvent(EVENTO_DISTRIBUIDORA_CREADA)
  async handle(evento: DistribuidoraCreadaEvent): Promise<void> {
    const yaTienePlanes = await this.plans.count({
      where: { distributorId: evento.distributorId },
    });
    if (yaTienePlanes > 0) {
      return;
    }

    const nuevos = BASE_PLAN_DEFINITIONS.map((definicion) =>
      this.plans.create({
        ...definicion,
        distributorId: evento.distributorId,
        carType: null,
        isActive: true,
      }),
    );
    await this.plans.save(nuevos);
    this.logger.log(
      `Sembrados ${nuevos.length} planes base de flota para la distribuidora ${evento.distributorId}`,
    );
  }
}
