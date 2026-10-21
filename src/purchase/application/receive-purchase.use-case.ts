import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { ahoraDeLaBase } from '../../common/utils/ahora-de-la-base';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import {
  DocType,
  DocumentSequenceService,
} from '../../document-sequence/document-sequence.service';
import { StockInsuficienteError } from '../../stock/domain/errors/stock.errors';
import {
  MovimientoDeStock,
  StockLedgerPort,
} from '../../stock/domain/ports/stock-ledger.port';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../../stock/domain/stock.enums';
import { StockLocationService } from '../../stock/application/stock-location.service';
import { StockOnHandService } from '../../stock/application/stock-on-hand.service';
import { WarehouseService } from '../../stock/application/warehouse.service';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import {
  CompraInvalidaError,
  OrdenNoRecibibleError,
} from '../domain/errors/purchase.errors';
import {
  PaymentStatus,
  PurchaseReceiptStatus,
  SupplierDocumentType,
} from '../domain/purchase.enums';
import {
  ESTADOS_RECIBIBLES,
  costoPromedioPonderado,
  estadoSegunRecibido,
  excesosDeRecepcion,
  pendienteDe,
  totalDe,
  validarRenglonesDeRecepcion,
  validarTransicion,
} from '../domain/purchase-rules';
import { CreatePurchaseReceiptDto } from '../dto/purchase-receipt.dto';
import { PurchaseOrderItem } from '../entities/purchase-order-item.entity';
import { PurchaseOrder } from '../entities/purchase-order.entity';
import { PurchaseReceiptItem } from '../entities/purchase-receipt-item.entity';
import { PurchaseReceipt } from '../entities/purchase-receipt.entity';
import { PurchaseOrderService } from './purchase-order.service';
import { SupplierService } from './supplier.service';
import { traducirErrorDeCompra } from './traducir-error-de-compra';

interface Renglon {
  gasCylinderId: string;
  quantityFull: number;
  quantityEmptyOut: number;
  unitCost: number;
}

/** Tolerancia para relojes desfasados al validar que `receivedAt` no sea futuro. */
const TOLERANCIA_FUTURO_MS = 5 * 60 * 1000;

/**
 * Confirma la recepción de una compra (remito de ingreso), con o sin orden. En
 * UNA transacción:
 *  1. lock de la orden (si hay) y validación contra lo pendiente;
 *  2. el ledger: +llenas en el depósito (sube el vendible) y −vacías que se
 *     llevó la planta, sin dejar el depósito en negativo;
 *  3. costo promedio ponderado de cada garrafa (ya bajo el lock de
 *     `gas_cylinder` que tomó el ledger);
 *  4. `received_quantity` y estado de la orden;
 *  5. el número interno (`document_sequence`, último lock) y el remito.
 *
 * Orden de locks: purchase_order → gas_cylinder → warehouse → stock_balance →
 * document_sequence.
 */
@Injectable()
export class ReceivePurchaseUseCase {
  private readonly logger = new Logger(ReceivePurchaseUseCase.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: StockLedgerPort,
    private readonly orders: PurchaseOrderService,
    private readonly suppliers: SupplierService,
    private readonly locations: StockLocationService,
    private readonly warehouses: WarehouseService,
    private readonly products: GasCylinderService,
    private readonly onHand: StockOnHandService,
    private readonly sequences: DocumentSequenceService,
  ) {}

  async execute(
    dto: CreatePurchaseReceiptDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<string> {
    const receivedAt = this.fechaDeRecepcion(dto.receivedAt);
    validarRenglonesDeRecepcion(
      dto.items.map((i) => ({
        gasCylinderId: i.gasCylinderId,
        quantityFull: i.quantityFull,
        quantityEmptyOut: i.quantityEmptyOut ?? 0,
      })),
    );
    // Con orden el depósito lo fija la orden (se valida en `recibir`, con la
    // orden bloqueada); sin orden, el indicado o el predeterminado.
    const defaultWarehouseId = dto.purchaseOrderId
      ? undefined
      : (dto.warehouseId ??
        (await this.warehouses.asegurarPredeterminado(distributorId)).warehouse
          .warehouseId);

    try {
      return await this.recibir(
        dto,
        distributorId,
        actorUserId,
        receivedAt,
        defaultWarehouseId,
      );
    } catch (error) {
      return traducirErrorDeCompra(error, this.logger, 'recepción de compra');
    }
  }

  private recibir(
    dto: CreatePurchaseReceiptDto,
    distributorId: string,
    actorUserId: string,
    receivedAt: Date,
    defaultWarehouseId: string | undefined,
  ): Promise<string> {
    return withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const orden = dto.purchaseOrderId
            ? await this.cargarOrden(
                manager,
                dto.purchaseOrderId,
                distributorId,
              )
            : null;
          const supplierId = this.proveedorDe(dto, orden?.orden ?? null);
          const warehouseId =
            defaultWarehouseId ?? orden?.orden.destinationWarehouseId;
          if (
            orden &&
            dto.warehouseId &&
            dto.warehouseId.toLowerCase() !==
              orden.orden.destinationWarehouseId.toLowerCase()
          ) {
            throw new CompraInvalidaError(
              `La orden de compra N° ${orden.orden.number} se recibe en su depósito de destino: el depósito indicado no coincide. Omití warehouseId o usá el de la orden`,
            );
          }
          if (!warehouseId) {
            throw new CompraInvalidaError('Indicá el depósito donde se recibe');
          }
          await this.suppliers.bloquearUsable(
            manager,
            supplierId,
            distributorId,
          );
          await this.asegurarDocumentoLibre(
            manager,
            distributorId,
            supplierId,
            dto.supplierDocumentType,
            dto.supplierDocumentNumber,
          );
          const renglones = this.renglones(dto, orden?.items ?? null);
          if (orden) await this.validarContraOrden(manager, orden, renglones);

          const ubicacion = await this.locations.ubicacionDeDeposito(
            manager,
            distributorId,
            warehouseId,
          );
          if (dto.receivedAt) {
            await this.validarNoAnteriorAlConteo(
              manager,
              distributorId,
              warehouseId,
              receivedAt,
            );
          }
          const receiptId = randomUUID();
          const { batchId } = await this.aplicarAlLedger(
            manager,
            distributorId,
            actorUserId,
            receiptId,
            ubicacion.locationId,
            renglones,
            receivedAt,
          );
          const previos = await this.actualizarCostos(
            manager,
            distributorId,
            renglones,
          );
          if (orden) await this.actualizarOrden(manager, orden, renglones);

          // El número va al final: document_sequence es el último lock.
          const number = await this.sequences.siguienteNumero(
            manager,
            distributorId,
            DocType.PURCHASE_RECEIPT,
          );
          await manager.save(
            manager.create(PurchaseReceipt, {
              receiptId,
              distributorId,
              number,
              supplierId,
              purchaseOrderId: orden?.orden.purchaseOrderId ?? null,
              warehouseId,
              supplierDocumentType: dto.supplierDocumentType,
              supplierDocumentNumber: dto.supplierDocumentNumber,
              receivedAt,
              receivedByUserId: actorUserId,
              totalAmount: totalDe(
                renglones.map((r) => ({
                  quantity: r.quantityFull,
                  unitCost: r.unitCost,
                })),
              ),
              paymentStatus: PaymentStatus.UNPAID,
              cashMovementId: null,
              status: PurchaseReceiptStatus.CONFIRMED,
              batchId,
              notes: dto.notes ?? null,
            }),
          );
          await manager.insert(
            PurchaseReceiptItem,
            renglones.map((r) => ({
              receiptId,
              ...r,
              previousAverageCost: previos.get(r.gasCylinderId)?.costo ?? null,
              previousOnHand: previos.get(r.gasCylinderId)?.existencia ?? null,
              previousOnHandAt: previos.get(r.gasCylinderId)?.leidaEn ?? null,
            })),
          );
          return receiptId;
        }),
      { context: 'recepción de compra' },
    );
  }

  /**
   * Una recepción no puede ser anterior al conteo inicial del depósito, si lo
   * tuvo: esas garrafas ya estarían en el conteo y se contarían dos veces. Sin
   * conteo no hay piso.
   */
  private async validarNoAnteriorAlConteo(
    manager: EntityManager,
    distributorId: string,
    warehouseId: string,
    receivedAt: Date,
  ): Promise<void> {
    const inicio = await this.onHand.inicioDeStockDelDeposito(
      manager,
      distributorId,
      warehouseId,
    );
    if (inicio && receivedAt.getTime() < inicio.getTime()) {
      throw new CompraInvalidaError(
        `La fecha de recepción (${receivedAt.toISOString()}) es anterior al conteo inicial de este depósito (${inicio.toISOString()}): esas garrafas ya están en el conteo`,
      );
    }
  }

  private fechaDeRecepcion(valor: string | undefined): Date {
    const fecha = valor ? new Date(valor) : new Date();
    if (Number.isNaN(fecha.getTime())) {
      throw new CompraInvalidaError('receivedAt no es una fecha válida');
    }
    if (fecha.getTime() > Date.now() + TOLERANCIA_FUTURO_MS) {
      throw new CompraInvalidaError(
        'La fecha de recepción no puede ser futura',
      );
    }
    return fecha;
  }

  private async cargarOrden(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<{ orden: PurchaseOrder; items: PurchaseOrderItem[] }> {
    const orden = await this.orders.bloquear(manager, id, distributorId);
    if (!ESTADOS_RECIBIBLES.includes(orden.status)) {
      throw new OrdenNoRecibibleError(orden.number, orden.status);
    }
    const items = await manager.find(PurchaseOrderItem, {
      where: { purchaseOrderId: id },
      order: { gasCylinderId: 'ASC' },
    });
    return { orden, items };
  }

  private proveedorDe(
    dto: CreatePurchaseReceiptDto,
    orden: PurchaseOrder | null,
  ): string {
    if (orden) {
      if (dto.supplierId && dto.supplierId !== orden.supplierId) {
        throw new CompraInvalidaError(
          'El proveedor indicado no es el de la orden de compra',
        );
      }
      return orden.supplierId;
    }
    if (!dto.supplierId) {
      throw new CompraInvalidaError(
        'Una compra sin orden necesita el proveedor (supplierId)',
      );
    }
    return dto.supplierId;
  }

  private renglones(
    dto: CreatePurchaseReceiptDto,
    itemsDeOrden: PurchaseOrderItem[] | null,
  ): Renglon[] {
    const deOrden = new Map(
      (itemsDeOrden ?? []).map((i) => [i.gasCylinderId, i]),
    );
    return dto.items.map((i) => {
      const quantityFull = i.quantityFull;
      const costoDeOrden = deOrden.get(i.gasCylinderId)?.unitCost;
      // Con orden, un renglón que no está en ella lo rechaza `validarContraOrden`.
      const unitCost =
        i.unitCost ??
        costoDeOrden ??
        (quantityFull === 0 || itemsDeOrden !== null ? 0 : undefined);
      if (unitCost === undefined) {
        throw new CompraInvalidaError(
          'Una compra sin orden necesita el costo unitario (unitCost) de cada renglón',
        );
      }
      return {
        gasCylinderId: i.gasCylinderId,
        quantityFull,
        quantityEmptyOut: i.quantityEmptyOut ?? 0,
        unitCost,
      };
    });
  }

  private async validarContraOrden(
    manager: EntityManager,
    { orden, items }: { orden: PurchaseOrder; items: PurchaseOrderItem[] },
    renglones: Renglon[],
  ): Promise<void> {
    const pedido = new Map(items.map((i) => [i.gasCylinderId, i]));
    const ajeno = renglones.find((r) => !pedido.has(r.gasCylinderId));
    if (ajeno) {
      throw new CompraInvalidaError(
        `${await this.tipoDe(manager, ajeno.gasCylinderId)} no está en la orden de compra N° ${orden.number}: recibila como compra directa o agregala a otra orden`,
      );
    }
    const excesos = excesosDeRecepcion(pedido, renglones);
    if (excesos.length > 0) {
      const detalle: string[] = [];
      for (const e of excesos) {
        detalle.push(
          `${await this.tipoDe(manager, e.gasCylinderId)}: llegan ${e.recibido} y sólo quedan ${e.pendiente} por recibir`,
        );
      }
      throw new CompraInvalidaError(
        `La recepción se pasa de lo pedido en la orden N° ${orden.number}. ${detalle.join('; ')}`,
      );
    }
  }

  private async tipoDe(
    manager: EntityManager,
    gasCylinderId: string,
  ): Promise<string> {
    const [fila]: Array<{ type: string }> = await manager.query(
      `SELECT "type" FROM "gas_cylinder" WHERE "gas_cylinder_id" = $1`,
      [gasCylinderId],
    );
    return fila?.type ?? gasCylinderId;
  }

  private async asegurarDocumentoLibre(
    manager: EntityManager,
    distributorId: string,
    supplierId: string,
    tipo: SupplierDocumentType,
    numero: string,
  ): Promise<void> {
    const filas: unknown[] = await manager.query(
      `SELECT 1 FROM "purchase_receipt"
       WHERE "distributor_id" = $1 AND "supplier_id" = $2
         AND "supplier_document_type" = $3 AND "supplier_document_number" = $4`,
      [distributorId, supplierId, tipo, numero],
    );
    if (filas.length > 0) {
      throw new ConflictException(
        `Ya hay una recepción de este proveedor con el mismo tipo de documento y número ${numero}`,
      );
    }
  }

  private async aplicarAlLedger(
    manager: EntityManager,
    distributorId: string,
    actorUserId: string,
    receiptId: string,
    locationId: string,
    renglones: Renglon[],
    receivedAt: Date,
  ) {
    const movimientos: MovimientoDeStock[] = [];
    for (const r of renglones) {
      if (r.quantityFull > 0) {
        movimientos.push({
          gasCylinderId: r.gasCylinderId,
          quantity: r.quantityFull,
          from: null,
          to: { locationId, condition: StockCondition.FULL },
          reason: StockMovementReason.PURCHASE_RECEIPT,
        });
      }
      if (r.quantityEmptyOut > 0) {
        movimientos.push({
          gasCylinderId: r.gasCylinderId,
          quantity: r.quantityEmptyOut,
          from: { locationId, condition: StockCondition.EMPTY },
          to: null,
          reason: StockMovementReason.PLANT_EMPTY_OUT,
        });
      }
    }
    try {
      return await this.ledger.aplicar(manager, {
        distributorId,
        referenceType: StockReferenceType.PURCHASE_RECEIPT,
        referenceId: receiptId,
        actorUserId,
        movimientos,
        occurredAt: receivedAt,
      });
    } catch (error) {
      if (error instanceof StockInsuficienteError) {
        throw new CompraInvalidaError(
          `No alcanzan las vacías que se lleva la planta: el depósito no puede quedar en negativo. ${error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Costo promedio ponderado por garrafa. El ledger ya dejó tomado el lock de
   * `gas_cylinder` (subió las llenas), así que nadie más cambia el promedio
   * mientras se calcula. La existencia previa es lo que había antes de esta
   * recepción: el total de llenas de hoy menos lo que acaba de entrar.
   */
  private async actualizarCostos(
    manager: EntityManager,
    distributorId: string,
    renglones: Renglon[],
  ): Promise<
    Map<string, { costo: number | null; existencia: number; leidaEn: Date }>
  > {
    const previos = new Map<
      string,
      { costo: number | null; existencia: number; leidaEn: Date }
    >();
    const conLlenas = renglones
      .filter((r) => r.quantityFull > 0)
      .sort((a, b) => a.gasCylinderId.localeCompare(b.gasCylinderId));
    for (const r of conLlenas) {
      const hoy = await this.onHand.llenasTotales(
        manager,
        distributorId,
        r.gasCylinderId,
      );
      const costoPrevio = await this.products.costoPromedio(
        manager,
        distributorId,
        r.gasCylinderId,
      );
      previos.set(r.gasCylinderId, {
        costo: costoPrevio,
        existencia: hoy - r.quantityFull,
        // Bajo el lock de la garrafa: ordena esta recepción contra las anulaciones.
        leidaEn: await ahoraDeLaBase(manager),
      });
      const promedio = costoPromedioPonderado({
        existenciaPrevia: hoy - r.quantityFull,
        costoPrevio,
        cantidad: r.quantityFull,
        costoNuevo: r.unitCost,
      });
      await this.products.fijarCostoPromedio(
        manager,
        distributorId,
        r.gasCylinderId,
        promedio,
      );
    }
    return previos;
  }

  private async actualizarOrden(
    manager: EntityManager,
    { orden, items }: { orden: PurchaseOrder; items: PurchaseOrderItem[] },
    renglones: Renglon[],
  ): Promise<void> {
    const recibido = new Map(
      renglones.map((r) => [r.gasCylinderId, r.quantityFull]),
    );
    for (const item of items) {
      item.receivedQuantity += recibido.get(item.gasCylinderId) ?? 0;
      if (pendienteDe(item) < 0) {
        throw new CompraInvalidaError('La recepción se pasa de lo pedido');
      }
    }
    await manager.save(items);
    const nuevo = estadoSegunRecibido(items);
    if (nuevo !== orden.status) {
      validarTransicion(orden.status, nuevo);
      orden.status = nuevo;
      await manager.save(orden);
    }
  }
}
