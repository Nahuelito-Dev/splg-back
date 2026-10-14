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
import {
  GarrafaNoEncontradaEnStockError,
  OperacionDeStockInvalidaError,
} from '../domain/errors/stock.errors';
import { conciliarVendible } from '../domain/stock-rules';
import { StockAdjustmentReason, StockCondition } from '../domain/stock.enums';
import { StockAdjustment } from '../entities/stock-adjustment.entity';
import { StockAdjustmentItem } from '../entities/stock-adjustment-item.entity';
import { CreateReconciliationAdjustmentDto } from '../dto/stock-operations.dto';
import { StockReconciliationService } from './stock-reconciliation.service';
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
    private readonly reconciliation: StockReconciliationService,
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
            throw new GarrafaNoEncontradaEnStockError(dto.gasCylinderId);
          }
          // Primero el lock (orden: gas_cylinder antes que saldos y numeración);
          // la diferencia se calcula con él tomado.
          const [bloqueada]: Array<{
            stock: number;
            reservation_deficit: number;
          }> = await manager.query(
            `SELECT "stock", "reservation_deficit" FROM "gas_cylinder" WHERE "gas_cylinder_id" = $1 FOR UPDATE`,
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
          // Con entregas que todavía no descontaron el físico, el físico está de
          // más y cualquier "diferencia" (o su ausencia) se calcula contra un
          // número equivocado: al reaplicarlas quedaría sobreventa. Se reaplican
          // primero, aunque el vendible parezca cuadrar.
          const sinDescontar =
            await this.reconciliation.unidadesSinMovimientoDe(
              manager,
              distributorId,
              dto.gasCylinderId,
            );
          if (sinDescontar > 0) {
            throw new ConflictException(
              `${fila.type} tiene ${sinDescontar} unidad(es) entregadas que todavía no descontaron el stock físico: primero reaplicá las entregas (POST /stock/reconciliation/reapply-deliveries) y volvé a conciliar`,
            );
          }
          const deficitDifference =
            bloqueada.reservation_deficit - d.overReserved;
          if (d.difference === 0 && deficitDifference === 0) {
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
          const delta = 0 - d.difference;
          if (delta !== 0) {
            await this.products.ajustarVendible(manager, distributorId, [
              { gasCylinderId: dto.gasCylinderId, delta },
            ]);
          }
          // El vendible quedó exacto: el déficit pasa a ser lo que hoy las
          // reservas superan al físico.
          await manager.query(
            `UPDATE "gas_cylinder" SET "reservation_deficit" = $2 WHERE "gas_cylinder_id" = $1`,
            [dto.gasCylinderId, d.overReserved],
          );

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
          // Un desfasaje sólo del déficit no mueve el vendible: el documento queda
          // sin renglón (la variación 0 no es válida) y la nota explica el cambio.
          if (delta !== 0) {
            await manager.getRepository(StockAdjustmentItem).insert({
              adjustmentId,
              gasCylinderId: dto.gasCylinderId,
              condition: StockCondition.FULL,
              quantityDelta: delta,
            });
          }
          return adjustmentId;
        }),
      { context: 'ajuste de conciliación' },
    );
  }
}
