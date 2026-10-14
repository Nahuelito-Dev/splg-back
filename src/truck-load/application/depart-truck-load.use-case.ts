import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import { ahoraDeLaBase } from '../../stock/application/reloj-de-la-base';
import { StockLocationService } from '../../stock/application/stock-location.service';
import { StockOnHandService } from '../../stock/application/stock-on-hand.service';
import {
  MovimientoDeStock,
  StockLedgerPort,
} from '../../stock/domain/ports/stock-ledger.port';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../../stock/domain/stock.enums';
import { CargaInvalidaError } from '../domain/errors/truck-load.errors';
import { TruckLoadStatus } from '../domain/truck-load.enums';
import { puedeHacer, validarQueLlevaAlgo } from '../domain/truck-load-rules';
import { TruckLoadItem } from '../entities/truck-load-item.entity';
import {
  TransicionDeCargaInvalidaError,
  asegurarAlcance,
  bloquearCarga,
} from './truck-load-support';

/**
 * Confirma la salida: el ledger pasa lo cargado del depósito de origen al
 * camión (`truck_load`) y la carga queda `on_route`. Todo en la misma
 * transacción: si no alcanza el stock del depósito, no sale y no se escribe
 * nada. El camión tiene que estar vacío. Orden de locks: truck_load -> (ledger) gas_cylinder -> warehouse ->
 * stock_balance.
 */
@Injectable()
export class DepartTruckLoadUseCase {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: StockLedgerPort,
    private readonly locations: StockLocationService,
    private readonly onHand: StockOnHandService,
  ) {}

  async execute(
    id: string,
    distributorId: string,
    actorUserId: string,
    alcance: string | undefined,
  ): Promise<void> {
    await withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const carga = await bloquearCarga(manager, id, distributorId);
          asegurarAlcance(carga, alcance);
          if (!puedeHacer('salir', carga.status)) {
            throw new TransicionDeCargaInvalidaError(
              carga.number,
              carga.status,
              'confirmar la salida',
            );
          }
          const items = await manager.find(TruckLoadItem, {
            where: { loadId: id },
            order: { gasCylinderId: 'ASC' },
          });
          validarQueLlevaAlgo(items);
          const camion = await this.locations.ubicacionDeVehiculo(
            manager,
            distributorId,
            carga.carId,
          );
          // El camión sale vacío: lo que ya tenga (una transferencia a mano) se
          // devolvería como "sobrante" al rendir; mejor devolverlo antes.
          if (
            (await this.onHand.tiposConSaldo(manager, camion.locationId))
              .length > 0
          ) {
            throw new CargaInvalidaError(
              'El camión todavía tiene garrafas en el stock: devolvelas al depósito con una transferencia antes de confirmar la salida',
            );
          }
          const movimientos: MovimientoDeStock[] = [];
          for (const item of items) {
            for (const [cantidad, condition] of [
              [item.loadedFull, StockCondition.FULL],
              [item.loadedEmpty, StockCondition.EMPTY],
            ] as const) {
              if (cantidad <= 0) continue;
              movimientos.push({
                gasCylinderId: item.gasCylinderId,
                quantity: cantidad,
                from: { locationId: carga.originLocationId, condition },
                to: { locationId: camion.locationId, condition },
                reason: StockMovementReason.TRUCK_LOAD,
              });
            }
          }
          await this.ledger.aplicar(manager, {
            distributorId,
            referenceType: StockReferenceType.TRUCK_LOAD,
            referenceId: carga.loadId,
            actorUserId,
            notes: `Salida del camión (carga N° ${carga.number})`,
            movimientos,
          });
          carga.status = TruckLoadStatus.ON_ROUTE;
          carga.departedAt = await ahoraDeLaBase(manager);
          await manager.save(carga);
        }),
      { context: 'salida del camión' },
    );
  }
}
