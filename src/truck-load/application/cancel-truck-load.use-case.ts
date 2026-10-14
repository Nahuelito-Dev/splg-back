import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ahoraDeLaBase } from '../../common/utils/ahora-de-la-base';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import { TruckLoadStatus } from '../domain/truck-load.enums';
import { puedeHacer } from '../domain/truck-load-rules';
import {
  TransicionDeCargaInvalidaError,
  bloquearCarga,
} from './truck-load-support';

/**
 * Cancela una carga que todavía no salió. En `loading` no se movió stock (sale
 * recién al confirmar la salida), así que cancelar sólo libera al camión y al
 * chofer para abrir otra carga.
 */
@Injectable()
export class CancelTruckLoadUseCase {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(
    id: string,
    reason: string,
    distributorId: string,
    actorUserId: string,
  ): Promise<void> {
    await withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const carga = await bloquearCarga(manager, id, distributorId);
          if (!puedeHacer('cancelar', carga.status)) {
            throw new TransicionDeCargaInvalidaError(
              carga.number,
              carga.status,
              'cancelar: sólo se cancela una carga que todavía no salió',
            );
          }
          carga.status = TruckLoadStatus.CANCELLED;
          carga.cancelReason = reason;
          carga.closedAt = await ahoraDeLaBase(manager);
          carga.closedByUserId = actorUserId;
          await manager.save(carga);
        }),
      { context: 'cancelación de carga' },
    );
  }
}
