import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import { OperacionDeStockInvalidaError } from '../domain/errors/stock.errors';
import {
  MovimientoDeStock,
  StockLedgerPort,
} from '../domain/ports/stock-ledger.port';
import {
  StockCondition,
  StockLocationKind,
  StockMovementReason,
  StockReferenceType,
} from '../domain/stock.enums';
import { CreateTransferDto } from '../dto/stock-operations.dto';
import { StockLocationService } from './stock-location.service';

/**
 * Transferencia entre dos ubicaciones: depósito a depósito, o depósito a
 * vehículo (y de vuelta). Sin tabla propia: son movimientos del libro con el
 * mismo lote y `reason = transfer`. El vendible no cambia (las llenas siguen
 * dentro del conjunto depósitos + camiones).
 */
@Injectable()
export class StockTransferUseCase {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: StockLedgerPort,
    private readonly locations: StockLocationService,
  ) {}

  /** Devuelve el id del lote. */
  async execute(
    dto: CreateTransferDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<string> {
    const repetidas = new Set<string>();
    for (const item of dto.items) {
      const clave = `${item.gasCylinderId}|${item.condition ?? StockCondition.FULL}`;
      if (repetidas.has(clave)) {
        throw new OperacionDeStockInvalidaError(
          'Hay dos renglones para la misma garrafa y condición',
        );
      }
      repetidas.add(clave);
    }
    return withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const origen = await this.locations.resolver(
            manager,
            distributorId,
            dto.from,
          );
          const destino = await this.locations.resolver(
            manager,
            distributorId,
            dto.to,
          );
          if (origen.locationId === destino.locationId) {
            throw new OperacionDeStockInvalidaError(
              'El origen y el destino son la misma ubicación',
            );
          }
          if (
            origen.kind === StockLocationKind.VEHICLE &&
            destino.kind === StockLocationKind.VEHICLE
          ) {
            throw new OperacionDeStockInvalidaError(
              'No se transfiere de un vehículo a otro: pasá por un depósito',
            );
          }
          const batchId = randomUUID();
          const movimientos: MovimientoDeStock[] = dto.items.map((item) => {
            const condition = item.condition ?? StockCondition.FULL;
            return {
              gasCylinderId: item.gasCylinderId,
              quantity: item.quantity,
              from: { locationId: origen.locationId, condition },
              to: { locationId: destino.locationId, condition },
              reason: StockMovementReason.TRANSFER,
            };
          });
          await this.ledger.aplicar(manager, {
            distributorId,
            referenceType: StockReferenceType.TRANSFER,
            referenceId: batchId,
            batchId,
            actorUserId,
            notes: dto.notes?.trim() || null,
            movimientos,
          });
          return batchId;
        }),
      { context: 'transferencia de stock' },
    );
  }
}
