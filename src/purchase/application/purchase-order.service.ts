import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import {
  DocType,
  DocumentSequenceService,
} from '../../document-sequence/document-sequence.service';
import { StockLocationService } from '../../stock/application/stock-location.service';
import { WarehouseService } from '../../stock/application/warehouse.service';
import {
  OrdenNoEncontradaError,
  CompraInvalidaError,
} from '../domain/errors/purchase.errors';
import { PurchaseOrderStatus } from '../domain/purchase.enums';
import {
  totalDe,
  validarEditable,
  validarFechaEsperada,
  validarTransicion,
} from '../domain/purchase-rules';
import {
  CancelPurchaseOrderDto,
  CloseShortPurchaseOrderDto,
  CreatePurchaseOrderDto,
  PurchaseOrderItemInputDto,
  UpdatePurchaseOrderDto,
} from '../dto/purchase-order.dto';
import { PurchaseOrder } from '../entities/purchase-order.entity';
import { PurchaseOrderItem } from '../entities/purchase-order-item.entity';
import { SupplierService } from './supplier.service';
import { traducirErrorDeCompra } from './traducir-error-de-compra';

/**
 * Altas y cambios de estado de la orden de compra. Toda operación sobre una
 * orden existente empieza por su lock (`FOR UPDATE`), que es lo primero del
 * orden de locks de compras: orden → garrafas → depósito → saldos → secuencia.
 */
@Injectable()
export class PurchaseOrderService {
  private readonly logger = new Logger(PurchaseOrderService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly suppliers: SupplierService,
    private readonly sequences: DocumentSequenceService,
    private readonly locations: StockLocationService,
    private readonly warehouses: WarehouseService,
  ) {}

  async create(
    dto: CreatePurchaseOrderDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<string> {
    try {
      return await this.crear(dto, distributorId, actorUserId);
    } catch (error) {
      return traducirErrorDeCompra(
        error,
        this.logger,
        'alta de orden de compra',
      );
    }
  }

  private async crear(
    dto: CreatePurchaseOrderDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<string> {
    validarFechaEsperada(dto.expectedDate, diaArgentino());
    const warehouseId =
      dto.destinationWarehouseId ??
      (await this.warehouses.asegurarPredeterminado(distributorId)).warehouse
        .warehouseId;
    return withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          await this.suppliers.bloquearUsable(
            manager,
            dto.supplierId,
            distributorId,
          );
          await this.locations.ubicacionDeDeposito(
            manager,
            distributorId,
            warehouseId,
          );
          await this.bloquearGarrafas(manager, distributorId, dto.items);
          // El número va al final: document_sequence es el último lock.
          const number = await this.sequences.siguienteNumero(
            manager,
            distributorId,
            DocType.PURCHASE_ORDER,
          );
          const orden = await manager.save(
            manager.create(PurchaseOrder, {
              distributorId,
              number,
              supplierId: dto.supplierId,
              destinationWarehouseId: warehouseId,
              status: PurchaseOrderStatus.DRAFT,
              expectedDate: dto.expectedDate ?? null,
              notes: dto.notes ?? null,
              totalAmount: totalDe(dto.items),
              createdByUserId: actorUserId,
            }),
          );
          await this.insertarRenglones(
            manager,
            orden.purchaseOrderId,
            dto.items,
          );
          return orden.purchaseOrderId;
        }),
      { context: 'alta de orden de compra' },
    );
  }

  /** Sólo en borrador. Si vienen `items`, reemplazan a los anteriores. */
  async update(
    id: string,
    dto: UpdatePurchaseOrderDto,
    distributorId: string,
  ): Promise<string> {
    try {
      return await this.editar(id, dto, distributorId);
    } catch (error) {
      return traducirErrorDeCompra(
        error,
        this.logger,
        'edición de orden de compra',
      );
    }
  }

  private async editar(
    id: string,
    dto: UpdatePurchaseOrderDto,
    distributorId: string,
  ): Promise<string> {
    return withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const orden = await this.bloquear(manager, id, distributorId);
          validarEditable(orden.status);
          if (dto.supplierId !== undefined) {
            await this.suppliers.bloquearUsable(
              manager,
              dto.supplierId,
              distributorId,
            );
            orden.supplierId = dto.supplierId;
          }
          if (dto.destinationWarehouseId !== undefined) {
            await this.locations.ubicacionDeDeposito(
              manager,
              distributorId,
              dto.destinationWarehouseId,
            );
            orden.destinationWarehouseId = dto.destinationWarehouseId;
          }
          if (dto.expectedDate !== undefined) {
            // Sólo se valida si la fecha cambia: una orden vieja se puede editar
            // (notas, renglones) sin tocar la fecha que ya tenía.
            if (dto.expectedDate !== orden.expectedDate) {
              validarFechaEsperada(dto.expectedDate, diaArgentino());
            }
            orden.expectedDate = dto.expectedDate;
          }
          if (dto.notes !== undefined) orden.notes = dto.notes;
          if (dto.items !== undefined) {
            await this.bloquearGarrafas(manager, distributorId, dto.items);
            await manager.delete(PurchaseOrderItem, { purchaseOrderId: id });
            await this.insertarRenglones(manager, id, dto.items);
            orden.totalAmount = totalDe(dto.items);
          }
          await manager.save(orden);
          return id;
        }),
      { context: 'edición de orden de compra' },
    );
  }

  async send(id: string, distributorId: string): Promise<string> {
    return this.cambiarEstado(
      id,
      distributorId,
      PurchaseOrderStatus.SENT,
      (o) => {
        o.issuedAt = new Date();
      },
    );
  }

  /**
   * Cancela una orden sin mercadería recibida. Con recepciones confirmadas —
   * aunque sean sólo de vacías— responde 409: se anulan primero, o se cierra
   * la orden con faltante.
   */
  async cancel(
    id: string,
    dto: CancelPurchaseOrderDto,
    distributorId: string,
  ): Promise<string> {
    return this.cambiarEstado(
      id,
      distributorId,
      PurchaseOrderStatus.CANCELLED,
      (o) => {
        o.cancelReason = dto.reason;
      },
      async (manager, orden) => {
        const confirmadas = await this.recepcionesConfirmadas(manager, orden);
        if (confirmadas > 0) {
          throw new ConflictException(
            `La orden de compra N° ${orden.number} tiene ${confirmadas} recepción(es) confirmada(s): anulalas antes de cancelarla` +
              (orden.status === PurchaseOrderStatus.PARTIALLY_RECEIVED
                ? ', o cerrala con faltante'
                : ''),
          );
        }
      },
    );
  }

  /** Cierra con faltante una orden parcialmente recibida: lo que falta ya no llega. */
  async closeShort(
    id: string,
    dto: CloseShortPurchaseOrderDto,
    distributorId: string,
  ): Promise<string> {
    return this.cambiarEstado(
      id,
      distributorId,
      PurchaseOrderStatus.CLOSED_SHORT,
      (o) => {
        o.closeReason = dto.reason;
      },
    );
  }

  /**
   * Lock exclusivo de la orden, dentro de la transacción de quien llama. 404 si
   * no existe o es de otra distribuidora.
   */
  async bloquear(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<PurchaseOrder> {
    const orden = await manager
      .getRepository(PurchaseOrder)
      .createQueryBuilder('o')
      .setLock('pessimistic_write')
      .where('o.purchaseOrderId = :id AND o.distributorId = :distributorId', {
        id,
        distributorId,
      })
      .getOne();
    if (!orden) throw new OrdenNoEncontradaError(id);
    return orden;
  }

  private cambiarEstado(
    id: string,
    distributorId: string,
    hacia: PurchaseOrderStatus,
    aplicar: (orden: PurchaseOrder) => void,
    verificar?: (manager: EntityManager, orden: PurchaseOrder) => Promise<void>,
  ): Promise<string> {
    return withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const orden = await this.bloquear(manager, id, distributorId);
          await verificar?.(manager, orden);
          validarTransicion(orden.status, hacia);
          orden.status = hacia;
          aplicar(orden);
          await manager.save(orden);
          return id;
        }),
      { context: `orden de compra a ${hacia}` },
    );
  }

  private async recepcionesConfirmadas(
    manager: EntityManager,
    orden: PurchaseOrder,
  ): Promise<number> {
    const [{ n }]: Array<{ n: number }> = await manager.query(
      `SELECT COUNT(*)::int AS n FROM "purchase_receipt"
       WHERE "purchase_order_id" = $1 AND "status" = 'confirmed'`,
      [orden.purchaseOrderId],
    );
    return n;
  }

  /**
   * Las garrafas de los renglones tienen que ser de la distribuidora (404 si
   * no). `FOR KEY SHARE` por id ascendente: es lo que pide la clave foránea del
   * renglón, y sigue el orden de locks (garrafas antes que la secuencia).
   */
  private async bloquearGarrafas(
    manager: EntityManager,
    distributorId: string,
    items: PurchaseOrderItemInputDto[],
  ): Promise<void> {
    const ids = [...new Set(items.map((i) => i.gasCylinderId))].sort((a, b) =>
      a.localeCompare(b),
    );
    if (ids.length !== items.length) {
      throw new CompraInvalidaError(
        'Una garrafa aparece dos veces en la orden: juntá las cantidades en un solo renglón',
      );
    }
    const filas: Array<{ gas_cylinder_id: string }> = await manager.query(
      `SELECT "gas_cylinder_id" FROM "gas_cylinder"
       WHERE "gas_cylinder_id" = ANY($1::uuid[]) AND "distributor_id" = $2
       ORDER BY "gas_cylinder_id"
       FOR KEY SHARE`,
      [ids, distributorId],
    );
    const vistas = new Set(filas.map((f) => f.gas_cylinder_id));
    const faltante = ids.find((id) => !vistas.has(id));
    if (faltante)
      throw new NotFoundException(`Garrafa no encontrada: ${faltante}`);
  }

  private async insertarRenglones(
    manager: EntityManager,
    purchaseOrderId: string,
    items: PurchaseOrderItemInputDto[],
  ): Promise<void> {
    await manager.insert(
      PurchaseOrderItem,
      items.map((i) => ({
        purchaseOrderId,
        gasCylinderId: i.gasCylinderId,
        quantity: i.quantity,
        unitCost: i.unitCost,
        emptiesToExchange: i.emptiesToExchange ?? 0,
      })),
    );
  }
}
