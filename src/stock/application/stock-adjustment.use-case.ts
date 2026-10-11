import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  DocType,
  DocumentSequenceService,
} from '../../document-sequence/document-sequence.service';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import { StockLedgerPort } from '../domain/ports/stock-ledger.port';
import {
  movimientosDeAjuste,
  validarItemsDeAjuste,
} from '../domain/stock-rules';
import { StockReferenceType } from '../domain/stock.enums';
import { StockAdjustment } from '../entities/stock-adjustment.entity';
import { StockAdjustmentItem } from '../entities/stock-adjustment-item.entity';
import { CreateAdjustmentDto } from '../dto/stock-operations.dto';
import { StockLocationService } from './stock-location.service';

/**
 * Registra un ajuste de stock (corrección de conteo, merma, fuga, rotura,
 * pérdida, hallazgo): un documento numerado con nota obligatoria, más los
 * movimientos del libro y el efecto en el vendible si toca llenas. Todo en una
 * sola transacción.
 */
@Injectable()
export class StockAdjustmentUseCase {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: StockLedgerPort,
    private readonly locations: StockLocationService,
    private readonly sequences: DocumentSequenceService,
  ) {}

  async execute(
    dto: CreateAdjustmentDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<string> {
    validarItemsDeAjuste(dto.reason, dto.items);
    return withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const ubicacion = await this.locations.resolver(
            manager,
            distributorId,
            dto.location,
          );
          const adjustmentId = randomUUID();
          const { batchId } = await this.ledger.aplicar(manager, {
            distributorId,
            referenceType: StockReferenceType.STOCK_ADJUSTMENT,
            referenceId: adjustmentId,
            actorUserId,
            movimientos: movimientosDeAjuste(
              dto.reason,
              ubicacion.locationId,
              dto.items,
            ),
          });
          // El número va al final: document_sequence es el último lock.
          const number = await this.sequences.siguienteNumero(
            manager,
            distributorId,
            DocType.STOCK_ADJUSTMENT,
          );
          await manager.getRepository(StockAdjustment).save(
            manager.getRepository(StockAdjustment).create({
              adjustmentId,
              distributorId,
              number,
              locationId: ubicacion.locationId,
              reason: dto.reason,
              notes: dto.notes,
              batchId,
              createdByUserId: actorUserId,
            }),
          );
          await manager.getRepository(StockAdjustmentItem).insert(
            dto.items.map((item) => ({
              adjustmentId,
              gasCylinderId: item.gasCylinderId,
              condition: item.condition,
              quantityDelta: item.quantityDelta,
            })),
          );
          return adjustmentId;
        }),
      { context: 'ajuste de stock' },
    );
  }
}
