import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import { TransicionDeCargaInvalidaError } from '../domain/errors/truck-load.errors';
import { puedeHacer, validarRenglones } from '../domain/truck-load-rules';
import { UpdateTruckLoadItemsDto } from '../dto/truck-load.dto';
import { TruckLoadItem } from '../entities/truck-load-item.entity';
import {
  bloquearCarga,
  bloquearGarrafasComoClaveForanea,
} from './truck-load-support';

/** Reemplaza los renglones de una carga que todavía no salió. No mueve stock. */
@Injectable()
export class UpdateTruckLoadItemsUseCase {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(
    id: string,
    dto: UpdateTruckLoadItemsDto,
    distributorId: string,
  ): Promise<void> {
    const renglones = dto.items.map((i) => ({
      gasCylinderId: i.gasCylinderId,
      loadedFull: i.loadedFull,
      loadedEmpty: i.loadedEmpty ?? 0,
    }));
    validarRenglones(renglones);
    await withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const carga = await bloquearCarga(manager, id, distributorId);
          if (!puedeHacer('editar', carga.status)) {
            throw new TransicionDeCargaInvalidaError(
              carga.number,
              carga.status,
              'cambiar los renglones',
            );
          }
          await bloquearGarrafasComoClaveForanea(
            manager,
            distributorId,
            renglones.map((r) => r.gasCylinderId),
          );
          await manager.delete(TruckLoadItem, { loadId: id });
          await manager.save(
            renglones.map((r) =>
              manager.create(TruckLoadItem, {
                loadId: id,
                gasCylinderId: r.gasCylinderId,
                loadedFull: r.loadedFull,
                loadedEmpty: r.loadedEmpty,
              }),
            ),
          );
        }),
      { context: 'edición de renglones de carga' },
    );
  }
}
