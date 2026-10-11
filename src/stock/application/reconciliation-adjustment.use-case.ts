import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  DocType,
  DocumentSequenceService,
} from '../../document-sequence/document-sequence.service';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import { OperacionDeStockInvalidaError } from '../domain/errors/stock.errors';
import { conciliarVendible } from '../domain/stock-rules';
import { StockAdjustmentReason, StockCondition } from '../domain/stock.enums';
import { StockAdjustment } from '../entities/stock-adjustment.entity';
import { StockAdjustmentItem } from '../entities/stock-adjustment-item.entity';
import { CreateReconciliationAdjustmentDto } from '../dto/stock-operations.dto';
import { WarehouseService } from './warehouse.service';

/**
 * Ajuste de conciliación: corrige SÓLO `gas_cylinder.stock` hasta que valga
 * `Σ llenas − Σ pedidos abiertos`, sin tocar el físico. Es la salida de un
 * desvío del vendible (alguien lo tocó por fuera, un alta vieja): corregirlo con
 * un ajuste de conteo lo habría duplicado.
 *
 * Queda como documento numerado y auditado (`stock_adjustment` con motivo
 * `reconciliation`, nota obligatoria, ubicación = depósito predeterminado) y SIN
 * movimiento en el libro físico, porque el físico no cambió. El renglón guarda la
 * variación aplicada al vendible. Mientras corre tiene `gas_cylinder` bloqueado
 * (el mismo lock que el pedido), así los pedidos nuevos esperan y la cuenta no
 * se mueve.
 */
@Injectable()
export class ReconciliationAdjustmentUseCase {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly products: GasCylinderService,
    private readonly orders: OrderLookupService,
    private readonly sequences: DocumentSequenceService,
    private readonly warehouses: WarehouseService,
  ) {}

  /** Devuelve el id del ajuste. */
  async execute(
    dto: CreateReconciliationAdjustmentDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<string> {
    return withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const adjustmentId = randomUUID();
          const [fila]: Array<{ stock: number; type: string }> =
            await manager.query(
              `SELECT "stock", "type" FROM "gas_cylinder"
               WHERE "gas_cylinder_id" = $1 AND "distributor_id" = $2`,
              [dto.gasCylinderId, distributorId],
            );
          if (!fila) {
            throw new OperacionDeStockInvalidaError(
              `Garrafa no encontrada: ${dto.gasCylinderId}`,
            );
          }
          // Primero el lock (orden: gas_cylinder antes que saldos y numeración);
          // la diferencia se calcula con él tomado.
          const [bloqueada]: Array<{ stock: number }> = await manager.query(
            `SELECT "stock" FROM "gas_cylinder" WHERE "gas_cylinder_id" = $1 FOR UPDATE`,
            [dto.gasCylinderId],
          );
          const [{ total }]: Array<{ total: string | null }> =
            await manager.query(
              `SELECT SUM("quantity") AS total FROM "stock_balance"
               WHERE "gas_cylinder_id" = $1 AND "condition" = 'full'`,
              [dto.gasCylinderId],
            );
          const reservadas = await this.orders.reservedByCylinder(
            distributorId,
            manager,
          );
          const d = conciliarVendible(
            dto.gasCylinderId,
            bloqueada.stock,
            Number(total ?? 0),
            reservadas.get(dto.gasCylinderId) ?? 0,
          );
          if (d.difference === 0) {
            throw new OperacionDeStockInvalidaError(
              `${fila.type} no tiene diferencia: el vendible ya coincide con el físico menos lo reservado`,
            );
          }
          if (
            dto.expectedDifference !== undefined &&
            dto.expectedDifference !== d.difference
          ) {
            throw new ConflictException(
              `La diferencia cambió: ahora es ${d.difference} y se esperaba ${dto.expectedDifference}. Revisá la conciliación de nuevo`,
            );
          }
          if (d.expected < 0) {
            throw new OperacionDeStockInvalidaError(
              `Las llenas físicas (${d.physicalFull}) son menos que lo reservado por pedidos (${d.reserved}): el vendible no puede quedar negativo. Corregí primero el físico con un ajuste o una transferencia`,
            );
          }

          const delta = -d.difference;
          await this.products.ajustarVendible(manager, distributorId, [
            { gasCylinderId: dto.gasCylinderId, delta },
          ]);

          const { locationId } = await this.warehouses.asegurarPredeterminado(
            distributorId,
            manager,
          );
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
              locationId,
              reason: StockAdjustmentReason.RECONCILIATION,
              notes: dto.notes,
              // Sin movimientos físicos: el lote existe sólo para cumplir el
              // esquema y no corresponde a ninguna fila del libro.
              batchId: randomUUID(),
              createdByUserId: actorUserId,
            }),
          );
          await manager.getRepository(StockAdjustmentItem).insert({
            adjustmentId,
            gasCylinderId: dto.gasCylinderId,
            condition: StockCondition.FULL,
            quantityDelta: delta,
          });
          return adjustmentId;
        }),
      { context: 'ajuste de conciliación' },
    );
  }
}
