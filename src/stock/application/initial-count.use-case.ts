import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  DocType,
  DocumentSequenceService,
} from '../../document-sequence/document-sequence.service';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import { OperacionDeStockInvalidaError } from '../domain/errors/stock.errors';
import { StockLedgerPort } from '../domain/ports/stock-ledger.port';
import {
  movimientosDeAjuste,
  validarItemsDeAjuste,
  variacionesDeConteo,
} from '../domain/stock-rules';
import {
  StockAdjustmentReason,
  StockCondition,
  StockReferenceType,
} from '../domain/stock.enums';
import { StockAdjustment } from '../entities/stock-adjustment.entity';
import { StockAdjustmentItem } from '../entities/stock-adjustment-item.entity';
import { Warehouse } from '../entities/warehouse.entity';
import { CreateInitialCountDto } from '../dto/stock-operations.dto';
import { StockLocationService } from './stock-location.service';

const NOTA_POR_DEFECTO = 'Conteo inicial del depósito';

/**
 * Conteo inicial de un depósito: lo que hay físicamente de cada tipo y
 * condición. Se registra como un ajuste `initial_count` con las diferencias
 * contra el saldo actual, así el vendible (`gas_cylinder.stock`) acompaña a las
 * llenas contadas (D4). Se hace una sola vez por depósito; después se corrige
 * con ajustes.
 */
@Injectable()
export class InitialCountUseCase {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: StockLedgerPort,
    private readonly locations: StockLocationService,
    private readonly sequences: DocumentSequenceService,
  ) {}

  async execute(
    dto: CreateInitialCountDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<string> {
    const garrafas = new Set(dto.items.map((i) => i.gasCylinderId));
    if (garrafas.size !== dto.items.length) {
      throw new OperacionDeStockInvalidaError(
        'Hay dos renglones para la misma garrafa',
      );
    }
    return withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const ubicacion = await this.locations.ubicacionDeDeposito(
            manager,
            distributorId,
            dto.warehouseId,
          );
          // Orden global de locks (splg-docs/sistema/back/STOCK.md): primero `gas_cylinder`, por id
          // ascendente. El conteo cambia llenas, así que va `FOR UPDATE` (lo mismo
          // que tomaría el ledger). Tomar el depósito antes cruzaba este conteo con
          // un ajuste o una transferencia (que toman garrafas y después el depósito
          // `FOR SHARE`) y Postgres abortaba uno por deadlock.
          await manager.query(
            `SELECT 1 FROM "gas_cylinder"
             WHERE "gas_cylinder_id" = ANY($1::uuid[]) AND "distributor_id" = $2
             ORDER BY "gas_cylinder_id"
             FOR UPDATE`,
            [[...garrafas], distributorId],
          );
          // Lock exclusivo del depósito: ninguna operación de stock lo usa
          // mientras se cuenta, así el saldo que se lee es el que se corrige.
          await manager
            .getRepository(Warehouse)
            .createQueryBuilder('w')
            .setLock('pessimistic_write')
            .where('w.warehouseId = :id', { id: dto.warehouseId })
            .getOne();

          const previo = await manager.getRepository(StockAdjustment).exists({
            where: {
              locationId: ubicacion.locationId,
              reason: StockAdjustmentReason.INITIAL_COUNT,
            },
          });
          if (previo) {
            throw new ConflictException(
              'Este depósito ya tiene su conteo inicial: corregilo con un ajuste',
            );
          }

          const saldos: Array<{
            gas_cylinder_id: string;
            condition: StockCondition;
            quantity: number;
          }> = await manager.query(
            `SELECT "gas_cylinder_id", "condition", "quantity" FROM "stock_balance"
             WHERE "location_id" = $1 AND "gas_cylinder_id" = ANY($2::uuid[])`,
            [ubicacion.locationId, [...garrafas]],
          );
          const actuales = new Map(
            saldos.map((s) => [
              `${s.gas_cylinder_id}|${s.condition}`,
              s.quantity,
            ]),
          );
          const contados = dto.items.flatMap((i) => [
            {
              gasCylinderId: i.gasCylinderId,
              condition: StockCondition.FULL,
              quantity: i.full,
            },
            {
              gasCylinderId: i.gasCylinderId,
              condition: StockCondition.EMPTY,
              quantity: i.empty ?? 0,
            },
            {
              gasCylinderId: i.gasCylinderId,
              condition: StockCondition.DEFECTIVE,
              quantity: i.defective ?? 0,
            },
          ]);
          const items = variacionesDeConteo(actuales, contados);
          if (items.length === 0) {
            throw new OperacionDeStockInvalidaError(
              'El conteo coincide con el saldo actual: no hay nada que registrar',
            );
          }
          validarItemsDeAjuste(StockAdjustmentReason.COUNT_CORRECTION, items);

          const adjustmentId = randomUUID();
          const { batchId } = await this.ledger.aplicar(manager, {
            distributorId,
            referenceType: StockReferenceType.STOCK_ADJUSTMENT,
            referenceId: adjustmentId,
            actorUserId,
            movimientos: movimientosDeAjuste(
              StockAdjustmentReason.INITIAL_COUNT,
              ubicacion.locationId,
              items,
            ),
          });
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
              reason: StockAdjustmentReason.INITIAL_COUNT,
              notes: dto.notes?.trim() || NOTA_POR_DEFECTO,
              batchId,
              createdByUserId: actorUserId,
            }),
          );
          await manager.getRepository(StockAdjustmentItem).insert(
            items.map((item) => ({
              adjustmentId,
              gasCylinderId: item.gasCylinderId,
              condition: item.condition,
              quantityDelta: item.quantityDelta,
            })),
          );
          return adjustmentId;
        }),
      { context: 'conteo inicial de stock' },
    );
  }
}
