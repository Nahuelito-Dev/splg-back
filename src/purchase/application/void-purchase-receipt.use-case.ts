import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { StockLedgerPort } from '../../stock/domain/ports/stock-ledger.port';
import { StockOnHandService } from '../../stock/application/stock-on-hand.service';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import {
  CompraInvalidaError,
  RecepcionNoEncontradaError,
} from '../domain/errors/purchase.errors';
import { PaymentStatus, PurchaseReceiptStatus } from '../domain/purchase.enums';
import {
  ESTADOS_QUE_SIGUEN_A_LO_RECIBIDO,
  costoPromedioAlAnular,
  estadoSegunRecibido,
  validarTransicion,
} from '../domain/purchase-rules';
import { VoidPurchaseReceiptDto } from '../dto/purchase-receipt.dto';
import { PurchaseOrderItem } from '../entities/purchase-order-item.entity';
import { PurchaseReceiptItem } from '../entities/purchase-receipt-item.entity';
import { PurchaseReceipt } from '../entities/purchase-receipt.entity';
import { PurchaseOrderService } from './purchase-order.service';
import { traducirErrorDeCompra } from './traducir-error-de-compra';

/**
 * Anula una recepción confirmada con un contraasiento del libro: las llenas
 * vuelven a salir del depósito y las vacías que se llevó la planta vuelven a
 * entrar. Si las llenas ya no están en el depósito (se vendieron, se cargaron
 * a un camión o se transfirieron) no se anula: 400 que dice dónde están hoy.
 *
 * Orden de locks: purchase_order → purchase_receipt → gas_cylinder → warehouse
 * → stock_balance.
 */
@Injectable()
export class VoidPurchaseReceiptUseCase {
  private readonly logger = new Logger(VoidPurchaseReceiptUseCase.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: StockLedgerPort,
    private readonly orders: PurchaseOrderService,
    private readonly products: GasCylinderService,
    private readonly onHand: StockOnHandService,
  ) {}

  async execute(
    id: string,
    dto: VoidPurchaseReceiptDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<string> {
    try {
      return await withTransactionRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            // La orden se bloquea ANTES que el remito (orden global de locks):
            // el remito se lee sin lock sólo para saber cuál es su orden.
            const previo = await manager.findOne(PurchaseReceipt, {
              where: { receiptId: id, distributorId },
            });
            if (!previo) throw new RecepcionNoEncontradaError(id);
            const orden = previo.purchaseOrderId
              ? await this.orders.bloquear(
                  manager,
                  previo.purchaseOrderId,
                  distributorId,
                )
              : null;
            const recepcion = await this.bloquearRecepcion(
              manager,
              id,
              distributorId,
            );
            this.validarAnulable(recepcion);

            const items = await manager.find(PurchaseReceiptItem, {
              where: { receiptId: id },
              order: { gasCylinderId: 'ASC' },
            });
            await this.contraasentar(
              manager,
              recepcion,
              dto.reason,
              distributorId,
              actorUserId,
              items,
            );
            await this.recalcularCostos(
              manager,
              distributorId,
              recepcion,
              items,
            );
            if (orden) {
              const renglones = await manager.find(PurchaseOrderItem, {
                where: { purchaseOrderId: orden.purchaseOrderId },
              });
              const devuelto = new Map(
                items.map((i) => [i.gasCylinderId, i.quantityFull]),
              );
              for (const r of renglones) {
                r.receivedQuantity -= devuelto.get(r.gasCylinderId) ?? 0;
                if (r.receivedQuantity < 0) {
                  throw new CompraInvalidaError(
                    'La orden de compra no tiene registrado lo que esta recepción recibió',
                  );
                }
              }
              await manager.save(renglones);
              // Una orden cancelada o cerrada con faltante conserva su estado.
              const nuevo = estadoSegunRecibido(renglones);
              if (
                ESTADOS_QUE_SIGUEN_A_LO_RECIBIDO.includes(orden.status) &&
                nuevo !== orden.status
              ) {
                validarTransicion(orden.status, nuevo);
                orden.status = nuevo;
                await manager.save(orden);
              }
            }
            recepcion.status = PurchaseReceiptStatus.VOIDED;
            recepcion.voidReason = dto.reason;
            recepcion.voidedAt = new Date();
            recepcion.voidedByUserId = actorUserId;
            await manager.save(recepcion);
            return id;
          }),
        { context: 'anulación de recepción de compra' },
      );
    } catch (error) {
      return traducirErrorDeCompra(
        error,
        this.logger,
        'anulación de recepción',
      );
    }
  }

  private async bloquearRecepcion(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<PurchaseReceipt> {
    const recepcion = await manager
      .getRepository(PurchaseReceipt)
      .createQueryBuilder('r')
      .setLock('pessimistic_write')
      .where('r.receiptId = :id AND r.distributorId = :distributorId', {
        id,
        distributorId,
      })
      .getOne();
    if (!recepcion) throw new RecepcionNoEncontradaError(id);
    return recepcion;
  }

  private validarAnulable(recepcion: PurchaseReceipt): void {
    if (recepcion.status === PurchaseReceiptStatus.VOIDED) {
      throw new ConflictException(
        `La recepción N° ${recepcion.number} ya está anulada`,
      );
    }
    if (recepcion.paymentStatus === PaymentStatus.PAID) {
      throw new CompraInvalidaError(
        `La recepción N° ${recepcion.number} figura como pagada: marcala como impaga antes de anularla`,
      );
    }
  }

  private async contraasentar(
    manager: EntityManager,
    recepcion: PurchaseReceipt,
    motivo: string,
    distributorId: string,
    actorUserId: string,
    items: PurchaseReceiptItem[],
  ): Promise<void> {
    try {
      const { batchId } = await this.ledger.contraasentar(manager, {
        distributorId,
        batchId: recepcion.batchId,
        actorUserId,
        notes: `Anulación de la recepción N° ${recepcion.number}: ${motivo}`,
      });
      recepcion.voidBatchId = batchId;
    } catch (error) {
      if (error instanceof ConflictException) {
        throw new ConflictException(
          await this.explicarFaltante(manager, recepcion, items, distributorId),
        );
      }
      throw error;
    }
  }

  /** Dónde están hoy las llenas que la recepción había traído. */
  private async explicarFaltante(
    manager: EntityManager,
    recepcion: PurchaseReceipt,
    items: PurchaseReceiptItem[],
    distributorId: string,
  ): Promise<string> {
    const partes: string[] = [];
    for (const item of items.filter((i) => i.quantityFull > 0)) {
      const [{ type }]: Array<{ type: string }> = await manager.query(
        `SELECT "type" FROM "gas_cylinder" WHERE "gas_cylinder_id" = $1`,
        [item.gasCylinderId],
      );
      const lugares = await this.onHand.dondeEstanLasLlenas(
        manager,
        distributorId,
        item.gasCylinderId,
      );
      const hoy =
        lugares.length === 0
          ? 'hoy no hay llenas en ningún depósito ni camión'
          : `hoy hay ${lugares.map((l) => `${l.quantity} en ${l.locationName}`).join(', ')}`;
      partes.push(
        `${type}: la recepción trajo ${item.quantityFull} llenas y ${hoy}`,
      );
    }
    return (
      `No se puede anular la recepción N° ${recepcion.number}: las garrafas que trajo ya no están en el depósito donde entraron ` +
      `(se vendieron, se cargaron a un camión o se transfirieron). ${partes.join('; ')}. ` +
      'Devolvelas a ese depósito (transferencia o ajuste) y anulá de nuevo.'
    );
  }

  /**
   * Costo promedio de cada garrafa al anular (regla en `costoPromedioAlAnular`).
   * El ledger ya tomó el lock de `gas_cylinder`, así que ninguna otra compra
   * cambia el promedio ni las demás recepciones mientras se recalcula.
   */
  private async recalcularCostos(
    manager: EntityManager,
    distributorId: string,
    recepcion: PurchaseReceipt,
    items: PurchaseReceiptItem[],
  ): Promise<void> {
    for (const item of items.filter((i) => i.quantityFull > 0)) {
      const actual = await this.products.costoPromedio(
        manager,
        distributorId,
        item.gasCylinderId,
      );
      const [otras]: Array<{
        cantidad: number;
        promedio: string | null;
        posterior: boolean | null;
      }> = await manager.query(
        `SELECT COUNT(*)::int AS cantidad,
                SUM(i."quantity_full" * i."unit_cost") / NULLIF(SUM(i."quantity_full"), 0) AS promedio,
                BOOL_OR(r."number" > $4) AS posterior
         FROM "purchase_receipt_item" i
         JOIN "purchase_receipt" r ON r."receipt_id" = i."receipt_id"
         WHERE r."distributor_id" = $1 AND i."gas_cylinder_id" = $2
           AND r."status" = 'confirmed' AND r."receipt_id" <> $3 AND i."quantity_full" > 0`,
        [
          distributorId,
          item.gasCylinderId,
          recepcion.receiptId,
          recepcion.number,
        ],
      );
      const nuevo = costoPromedioAlAnular({
        costoActual: actual,
        costoPrevio: item.previousAverageCost,
        existenciaPrevia: item.previousOnHand,
        cantidad: item.quantityFull,
        costoRecibido: item.unitCost,
        hayOtrasCompras: otras.cantidad > 0,
        hayCompraPosterior: otras.posterior === true,
        promedioDeLasOtras:
          otras.promedio === null
            ? null
            : Math.round(Number(otras.promedio) * 100) / 100,
      });
      if (nuevo !== actual) {
        await this.products.fijarCostoPromedio(
          manager,
          distributorId,
          item.gasCylinderId,
          nuevo,
        );
      }
    }
  }
}
