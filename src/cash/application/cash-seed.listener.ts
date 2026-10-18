import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  DistribuidoraCreadaEvent,
  EVENTO_DISTRIBUIDORA_CREADA,
} from '../../distributor/events/distribuidora-creada.event';
import { CashBoxService } from './cash-box.service';

/**
 * Siembra la "Caja central" y las categorías de sistema cuando se da de alta
 * una distribuidora. Las que ya existían las cubre la migración `CajaYRendicion`.
 * Idempotente.
 */
@Injectable()
export class CashSeedListener {
  private readonly logger = new Logger(CashSeedListener.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cajas: CashBoxService,
  ) {}

  @OnEvent(EVENTO_DISTRIBUIDORA_CREADA)
  async handle(evento: DistribuidoraCreadaEvent): Promise<void> {
    await this.dataSource.transaction((manager) =>
      this.cajas.asegurarCajaCentral(manager, evento.distributorId),
    );
    this.logger.log(
      `Caja central y categorías aseguradas para la distribuidora ${evento.distributorId}`,
    );
  }
}
