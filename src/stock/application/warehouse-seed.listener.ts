import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  DistribuidoraCreadaEvent,
  EVENTO_DISTRIBUIDORA_CREADA,
} from '../../distributor/events/distribuidora-creada.event';
import { WarehouseService } from './warehouse.service';

/**
 * Crea el "Depósito central" predeterminado cuando se da de alta una
 * distribuidora. Escucha el evento en vez de que `distributor` llame a `stock`
 * (CONVENCIONES §4). Las distribuidoras que ya existían las cubre la migración
 * `StockFisico`. Es idempotente: si ya tiene un predeterminado, no hace nada.
 */
@Injectable()
export class WarehouseSeedListener {
  private readonly logger = new Logger(WarehouseSeedListener.name);

  constructor(private readonly warehouses: WarehouseService) {}

  @OnEvent(EVENTO_DISTRIBUIDORA_CREADA)
  async handle(evento: DistribuidoraCreadaEvent): Promise<void> {
    await this.warehouses.asegurarPredeterminado(evento.distributorId);
    this.logger.log(
      `Depósito predeterminado asegurado para la distribuidora ${evento.distributorId}`,
    );
  }
}
