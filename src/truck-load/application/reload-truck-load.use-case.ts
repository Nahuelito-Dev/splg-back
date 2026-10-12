import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import { StockLocationService } from '../../stock/application/stock-location.service';
import { StockLedgerPort } from '../../stock/domain/ports/stock-ledger.port';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../../stock/domain/stock.enums';
import {
  CargaInvalidaError,
  TransicionDeCargaInvalidaError,
} from '../domain/errors/truck-load.errors';
import { puedeHacer } from '../domain/truck-load-rules';
import { ReloadTruckLoadDto } from '../dto/truck-load.dto';
import { bloquearCarga } from './truck-load-support';

/**
 * Reposición en ruta: más llenas del depósito de origen al camión, sobre la
 * misma carga. Una operación del ledger (`truck_load`) y la suma en el renglón
 * (`reloaded_full`), en la misma transacción.
 */
@Injectable()
export class ReloadTruckLoadUseCase {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: StockLedgerPort,
    private readonly locations: StockLocationService,
  ) {}

  async execute(
    id: string,
    dto: ReloadTruckLoadDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<void> {
    const ids = new Set(dto.items.map((i) => i.gasCylinderId));
    if (ids.size !== dto.items.length) {
      throw new CargaInvalidaError(
        'Hay dos renglones para la misma garrafa: sumá las cantidades en uno solo',
      );
    }
    await withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const carga = await bloquearCarga(manager, id, distributorId);
          if (!puedeHacer('reponer', carga.status)) {
            throw new TransicionDeCargaInvalidaError(
              carga.number,
              carga.status,
              'reponer garrafas',
            );
          }
          const camion = await this.locations.ubicacionDeVehiculo(
            manager,
            distributorId,
            carga.carId,
          );
          await this.ledger.aplicar(manager, {
            distributorId,
            referenceType: StockReferenceType.TRUCK_LOAD,
            referenceId: carga.loadId,
            actorUserId,
            notes: `Reposición en ruta (carga N° ${carga.number})`,
            movimientos: dto.items.map((i) => ({
              gasCylinderId: i.gasCylinderId,
              quantity: i.quantity,
              from: {
                locationId: carga.originLocationId,
                condition: StockCondition.FULL,
              },
              to: {
                locationId: camion.locationId,
                condition: StockCondition.FULL,
              },
              reason: StockMovementReason.TRUCK_LOAD,
            })),
          });
          // El renglón se crea si la garrafa no estaba en la carga. El ledger
          // ya tomó `gas_cylinder`, así que la clave foránea no espera nada nuevo.
          await manager.query(
            `INSERT INTO "truck_load_item" ("load_id", "gas_cylinder_id", "reloaded_full")
             SELECT $1, g, q
             FROM unnest($2::uuid[], $3::int[]) AS k(g, q)
             ON CONFLICT ("load_id", "gas_cylinder_id")
             DO UPDATE SET "reloaded_full" = "truck_load_item"."reloaded_full" + EXCLUDED."reloaded_full"`,
            [
              id,
              dto.items.map((i) => i.gasCylinderId),
              dto.items.map((i) => i.quantity),
            ],
          );
        }),
      { context: 'reposición en ruta' },
    );
  }
}
