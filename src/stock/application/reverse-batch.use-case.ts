import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import {
  LoteNoEncontradoError,
  OperacionDeStockInvalidaError,
} from '../domain/errors/stock.errors';
import { StockLedgerPort } from '../domain/ports/stock-ledger.port';
import { StockReferenceType } from '../domain/stock.enums';
import { StockMovement } from '../entities/stock-movement.entity';

/**
 * Corrige una transferencia con su contraasiento. Los demás lotes tienen su
 * propia corrección: un ajuste se corrige con otro ajuste; la recepción y la
 * carga del camión, con su anulación.
 */
@Injectable()
export class ReverseBatchUseCase {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: StockLedgerPort,
  ) {}

  /** Devuelve el id del lote del contraasiento. */
  async execute(
    batchId: string,
    notes: string | undefined,
    distributorId: string,
    actorUserId: string,
  ): Promise<string> {
    return withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const primero = await manager.getRepository(StockMovement).findOne({
            where: { batchId, distributorId },
          });
          if (!primero) throw new LoteNoEncontradoError(batchId);
          if (primero.referenceType !== StockReferenceType.TRANSFER) {
            throw new OperacionDeStockInvalidaError(
              'Sólo se contraasientan transferencias; un ajuste se corrige con otro ajuste',
            );
          }
          const { batchId: nuevo } = await this.ledger.contraasentar(manager, {
            distributorId,
            batchId,
            actorUserId,
            notes: notes?.trim() || null,
          });
          return nuevo;
        }),
      { context: 'contraasiento de stock' },
    );
  }
}
