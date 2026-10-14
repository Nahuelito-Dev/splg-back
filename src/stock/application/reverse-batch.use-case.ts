import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import {
  LoteNoEncontradoError,
  OperacionDeStockInvalidaError,
} from '../domain/errors/stock.errors';
import { StockLedgerPort } from '../domain/ports/stock-ledger.port';
import { StockReferenceType } from '../domain/stock.enums';
import { StockMovement } from '../entities/stock-movement.entity';
import { MENSAJE_CAMION_POR_CARGA } from './stock-transfer.use-case';

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
          await this.validarDestinoDelContraasiento(manager, batchId);
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

  /**
   * El contraasiento invierte la transferencia, así que aplica las mismas reglas
   * que `StockTransferUseCase` al revés: no mete stock en un camión (se carga
   * sólo por la carga del día; si no, sería un sobrante fantasma en la rendición)
   * y no saca stock de un camión con la carga abierta (se rinde desde la carga).
   * Lee `truck_load` de sólo lectura, como la transferencia.
   */
  private async validarDestinoDelContraasiento(
    manager: EntityManager,
    batchId: string,
  ): Promise<void> {
    const [haciaCamion]: Array<{ patente: string | null }> =
      await manager.query(
        `SELECT c."car_patent" AS patente
         FROM "stock_movement" m
         JOIN "stock_location" l ON l."location_id" = m."from_location_id"
         JOIN "car" c ON c."car_id" = l."car_id"
         WHERE m."batch_id" = $1 AND l."kind" = 'vehicle'
         LIMIT 1`,
        [batchId],
      );
    if (haciaCamion) {
      throw new ConflictException(
        `${MENSAJE_CAMION_POR_CARGA}: el contraasiento devolvería garrafas al camión ${haciaCamion.patente ?? ''}. ` +
          'Si el camión las necesita, abrí su carga; si no, registrá un ajuste.',
      );
    }
    const [conCarga]: Array<{ number: number }> = await manager.query(
      `SELECT t."number"
       FROM "stock_movement" m
       JOIN "stock_location" l ON l."location_id" = m."to_location_id"
       JOIN "truck_load" t ON t."car_id" = l."car_id"
       WHERE m."batch_id" = $1 AND l."kind" = 'vehicle'
         AND t."status"::text IN ('loading', 'on_route', 'returned')
       LIMIT 1`,
      [batchId],
    );
    if (conCarga) {
      throw new ConflictException(
        `${MENSAJE_CAMION_POR_CARGA}: el camión tiene abierta la carga N° ${conCarga.number}`,
      );
    }
  }
}
