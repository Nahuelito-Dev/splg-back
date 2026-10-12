import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { rangoDeDiasArgentinos } from '../../common/utils/dias-argentina';
import {
  OrdenNoEncontradaError,
  ProveedorNoEncontradoError,
  RecepcionNoEncontradaError,
} from '../domain/errors/purchase.errors';
import {
  PaymentStatus,
  PurchaseOrderStatus,
  PurchaseReceiptStatus,
  SupplierDocumentType,
} from '../domain/purchase.enums';
import {
  PendingItemDto,
  PurchaseOrderItemResponseDto,
  PurchaseOrderPageDto,
  PurchaseOrderPendingDto,
  PurchaseOrderResponseDto,
  PurchaseOrderSummaryDto,
  QueryPurchaseOrderDto,
} from '../dto/purchase-order.dto';
import {
  AverageCostDto,
  PurchaseReceiptItemResponseDto,
  PurchaseReceiptPageDto,
  PurchaseReceiptResponseDto,
  PurchaseReceiptSummaryDto,
  QueryPurchaseReceiptDto,
  QuerySupplierHistoryDto,
  SupplierHistoryDto,
} from '../dto/purchase-receipt.dto';

interface FilaDeOrden {
  purchase_order_id: string;
  number: number;
  supplier_id: string;
  supplier_name: string;
  destination_warehouse_id: string;
  warehouse_name: string;
  status: PurchaseOrderStatus;
  issued_at: Date | null;
  expected_date: string | null;
  total_amount: string;
  cancel_reason: string | null;
  close_reason: string | null;
  notes: string | null;
  ordered: number;
  received: number;
  createdAt: Date;
  updatedAt: Date;
}

interface FilaDeRecepcion {
  receipt_id: string;
  number: number;
  supplier_id: string;
  supplier_name: string;
  purchase_order_id: string | null;
  po_number: number | null;
  warehouse_id: string;
  warehouse_name: string;
  supplier_document_type: SupplierDocumentType;
  supplier_document_number: string;
  received_at: Date;
  total_amount: string;
  payment_status: PaymentStatus;
  status: PurchaseReceiptStatus;
}

const SIN_PENDIENTE: readonly PurchaseOrderStatus[] = [
  PurchaseOrderStatus.CANCELLED,
  PurchaseOrderStatus.CLOSED_SHORT,
];

const SELECT_ORDEN = `
  SELECT o."purchase_order_id", o."number", o."supplier_id", s."business_name" AS supplier_name,
         o."destination_warehouse_id", w."name" AS warehouse_name, o."status", o."issued_at",
         o."expected_date"::text AS expected_date, o."total_amount", o."cancel_reason", o."close_reason", o."notes",
         COALESCE(i.ordered, 0)::int AS ordered, COALESCE(i.received, 0)::int AS received,
         o."createdAt", o."updatedAt"
  FROM "purchase_order" o
  JOIN "supplier" s ON s."supplier_id" = o."supplier_id"
  JOIN "warehouse" w ON w."warehouse_id" = o."destination_warehouse_id"
  LEFT JOIN (
    SELECT "purchase_order_id", SUM("quantity") AS ordered, SUM("received_quantity") AS received
    FROM "purchase_order_item" GROUP BY "purchase_order_id"
  ) i ON i."purchase_order_id" = o."purchase_order_id"`;

const SELECT_RECEPCION = `
  SELECT r."receipt_id", r."number", r."supplier_id", s."business_name" AS supplier_name,
         r."purchase_order_id", po."number" AS po_number, r."warehouse_id", w."name" AS warehouse_name,
         r."supplier_document_type", r."supplier_document_number", r."received_at",
         r."total_amount", r."payment_status", r."status"
  FROM "purchase_receipt" r
  JOIN "supplier" s ON s."supplier_id" = r."supplier_id"
  JOIN "warehouse" w ON w."warehouse_id" = r."warehouse_id"
  LEFT JOIN "purchase_order" po ON po."purchase_order_id" = r."purchase_order_id"`;

/** Lecturas del módulo de compras. Sólo SELECT, siempre acotadas a la distribuidora. */
@Injectable()
export class PurchaseQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async ordenes(
    distributorId: string,
    query: QueryPurchaseOrderDto,
  ): Promise<PurchaseOrderPageDto> {
    const params: unknown[] = [distributorId];
    const where = ['o."distributor_id" = $1'];
    if (query.status) {
      params.push(query.status);
      where.push(`o."status" = $${params.length}`);
    }
    if (query.supplierId) {
      params.push(query.supplierId);
      where.push(`o."supplier_id" = $${params.length}`);
    }
    this.filtroDeFechas(where, params, 'o."createdAt"', query.from, query.to);
    const { limit, offset } = this.pagina(query.page, query.limit);
    const [{ total }]: Array<{ total: string }> = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM "purchase_order" o WHERE ${where.join(' AND ')}`,
      params,
    );
    const filas: FilaDeOrden[] = await this.dataSource.query(
      `${SELECT_ORDEN} WHERE ${where.join(' AND ')}
       ORDER BY o."number" DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return {
      data: filas.map((f) => this.aResumenDeOrden(f)),
      total: Number(total),
    };
  }

  async orden(
    id: string,
    distributorId: string,
  ): Promise<PurchaseOrderResponseDto> {
    const [fila]: FilaDeOrden[] = await this.dataSource.query(
      `${SELECT_ORDEN} WHERE o."purchase_order_id" = $1 AND o."distributor_id" = $2`,
      [id, distributorId],
    );
    if (!fila) throw new OrdenNoEncontradaError(id);
    const items = await this.renglonesDeOrden(id);
    const recepciones: FilaDeRecepcion[] = await this.dataSource.query(
      `${SELECT_RECEPCION}
       WHERE r."purchase_order_id" = $1 AND r."distributor_id" = $2
       ORDER BY r."number"`,
      [id, distributorId],
    );
    return Object.assign(
      new PurchaseOrderResponseDto(),
      this.aResumenDeOrden(fila),
      {
        items,
        receipts: recepciones.map((r) => this.aResumenDeRecepcion(r)),
      },
    );
  }

  /** Lo que falta recibir de cada renglón de la orden. */
  async pendiente(
    id: string,
    distributorId: string,
  ): Promise<PurchaseOrderPendingDto> {
    const [orden]: Array<{
      purchase_order_id: string;
      number: number;
      status: PurchaseOrderStatus;
    }> = await this.dataSource.query(
      `SELECT "purchase_order_id", "number", "status" FROM "purchase_order"
         WHERE "purchase_order_id" = $1 AND "distributor_id" = $2`,
      [id, distributorId],
    );
    if (!orden) throw new OrdenNoEncontradaError(id);
    const items = await this.renglonesDeOrden(id);
    const dto = new PurchaseOrderPendingDto();
    dto.purchaseOrderId = orden.purchase_order_id;
    dto.number = orden.number;
    dto.status = orden.status;
    dto.items = items.map((i) => {
      const p = new PendingItemDto();
      p.gasCylinderId = i.gasCylinderId;
      p.gasCylinderType = i.gasCylinderType;
      p.ordered = i.quantity;
      p.received = i.receivedQuantity;
      p.pending = i.pendingQuantity;
      p.emptiesToExchange = i.emptiesToExchange;
      return p;
    });
    // Una orden cancelada o cerrada con faltante no espera nada.
    if (SIN_PENDIENTE.includes(orden.status)) {
      dto.items.forEach((p) => (p.pending = 0));
    }
    dto.totalPending = dto.items.reduce((acc, p) => acc + p.pending, 0);
    return dto;
  }

  async recepciones(
    distributorId: string,
    query: QueryPurchaseReceiptDto,
  ): Promise<PurchaseReceiptPageDto> {
    const params: unknown[] = [distributorId];
    const where = ['r."distributor_id" = $1'];
    const filtro = (columna: string, valor: string | undefined) => {
      if (valor === undefined) return;
      params.push(valor);
      where.push(`${columna} = $${params.length}`);
    };
    filtro('r."supplier_id"', query.supplierId);
    filtro('r."purchase_order_id"', query.purchaseOrderId);
    filtro('r."payment_status"::text', query.paymentStatus);
    filtro('r."status"::text', query.status);
    this.filtroDeFechas(where, params, 'r."received_at"', query.from, query.to);
    return this.paginaDeRecepciones(where, params, query.page, query.limit);
  }

  async recepcion(
    id: string,
    distributorId: string,
  ): Promise<PurchaseReceiptResponseDto> {
    const [fila]: Array<
      FilaDeRecepcion & {
        notes: string | null;
        void_reason: string | null;
        voided_at: Date | null;
        received_by_user_id: string;
        batch_id: string;
        void_batch_id: string | null;
        cash_movement_id: string | null;
        createdAt: Date;
      }
    > = await this.dataSource.query(
      `SELECT x.*, r."notes", r."void_reason", r."voided_at", r."received_by_user_id", r."batch_id",
              r."void_batch_id", r."cash_movement_id", r."createdAt"
       FROM (${SELECT_RECEPCION} WHERE r."receipt_id" = $1 AND r."distributor_id" = $2) x
       JOIN "purchase_receipt" r ON r."receipt_id" = x."receipt_id"`,
      [id, distributorId],
    );
    if (!fila) throw new RecepcionNoEncontradaError(id);
    const items: Array<{
      item_id: string;
      gas_cylinder_id: string;
      type: string;
      quantity_full: number;
      quantity_empty_out: number;
      unit_cost: string;
    }> = await this.dataSource.query(
      `SELECT i."item_id", i."gas_cylinder_id", g."type", i."quantity_full", i."quantity_empty_out", i."unit_cost"
       FROM "purchase_receipt_item" i
       JOIN "gas_cylinder" g ON g."gas_cylinder_id" = i."gas_cylinder_id"
       WHERE i."receipt_id" = $1
       ORDER BY g."type"`,
      [id],
    );
    return Object.assign(
      new PurchaseReceiptResponseDto(),
      this.aResumenDeRecepcion(fila),
      {
        items: items.map((i) =>
          Object.assign(new PurchaseReceiptItemResponseDto(), {
            itemId: i.item_id,
            gasCylinderId: i.gas_cylinder_id,
            gasCylinderType: i.type,
            quantityFull: i.quantity_full,
            quantityEmptyOut: i.quantity_empty_out,
            unitCost: Number(i.unit_cost),
            subtotal: redondear(Number(i.unit_cost) * i.quantity_full),
          }),
        ),
        notes: fila.notes,
        voidReason: fila.void_reason,
        voidedAt: fila.voided_at,
        receivedByUserId: fila.received_by_user_id,
        batchId: fila.batch_id,
        voidBatchId: fila.void_batch_id,
        cashMovementId: fila.cash_movement_id,
        createdAt: fila.createdAt,
      },
    );
  }

  /** Historial de compras de un proveedor (también si está dado de baja). */
  async historialDeProveedor(
    supplierId: string,
    distributorId: string,
    query: QuerySupplierHistoryDto,
  ): Promise<SupplierHistoryDto> {
    const [proveedor]: Array<{ business_name: string }> =
      await this.dataSource.query(
        `SELECT "business_name" FROM "supplier" WHERE "supplier_id" = $1 AND "distributor_id" = $2`,
        [supplierId, distributorId],
      );
    if (!proveedor) throw new ProveedorNoEncontradoError(supplierId);
    const params: unknown[] = [distributorId, supplierId];
    const where = ['r."distributor_id" = $1', 'r."supplier_id" = $2'];
    this.filtroDeFechas(where, params, 'r."received_at"', query.from, query.to);
    const [totales]: Array<{
      cantidad: number;
      monto: string;
      llenas: number;
    }> = await this.dataSource.query(
      `SELECT COUNT(*)::int AS cantidad, COALESCE(SUM(r."total_amount"), 0) AS monto,
                COALESCE(SUM(i.llenas), 0)::int AS llenas
         FROM "purchase_receipt" r
         LEFT JOIN (SELECT "receipt_id", SUM("quantity_full") AS llenas
                    FROM "purchase_receipt_item" GROUP BY "receipt_id") i ON i."receipt_id" = r."receipt_id"
         WHERE ${where.join(' AND ')} AND r."status" = 'confirmed'`,
      params,
    );
    const pagina = await this.paginaDeRecepciones(
      where,
      params,
      query.page,
      query.limit,
    );
    return Object.assign(new SupplierHistoryDto(), {
      supplierId,
      supplierName: proveedor.business_name,
      receiptsCount: totales.cantidad,
      totalAmount: Number(totales.monto),
      fullReceived: totales.llenas,
      data: pagina.data,
      total: pagina.total,
    });
  }

  /** Costo promedio ponderado por garrafa, con la última compra y las llenas que hay. */
  async costosPromedio(distributorId: string): Promise<AverageCostDto[]> {
    const filas: Array<{
      gas_cylinder_id: string;
      type: string;
      average_unit_cost: string | null;
      last_unit_cost: string | null;
      last_received_at: Date | null;
      full_on_hand: number;
    }> = await this.dataSource.query(
      `SELECT g."gas_cylinder_id", g."type", g."average_unit_cost",
              ult."unit_cost" AS last_unit_cost, ult."received_at" AS last_received_at,
              COALESCE((SELECT SUM(b."quantity") FROM "stock_balance" b
                        WHERE b."gas_cylinder_id" = g."gas_cylinder_id" AND b."condition" = 'full'), 0)::int AS full_on_hand
       FROM "gas_cylinder" g
       LEFT JOIN LATERAL (
         SELECT i."unit_cost", r."received_at"
         FROM "purchase_receipt_item" i
         JOIN "purchase_receipt" r ON r."receipt_id" = i."receipt_id"
         WHERE i."gas_cylinder_id" = g."gas_cylinder_id" AND r."status" = 'confirmed' AND i."quantity_full" > 0
         ORDER BY r."received_at" DESC, r."number" DESC
         LIMIT 1
       ) ult ON true
       WHERE g."distributor_id" = $1
       ORDER BY g."type"`,
      [distributorId],
    );
    return filas.map((f) =>
      Object.assign(new AverageCostDto(), {
        gasCylinderId: f.gas_cylinder_id,
        gasCylinderType: f.type,
        averageUnitCost:
          f.average_unit_cost === null ? null : Number(f.average_unit_cost),
        lastUnitCost:
          f.last_unit_cost === null ? null : Number(f.last_unit_cost),
        lastReceivedAt: f.last_received_at,
        fullOnHand: f.full_on_hand,
      }),
    );
  }

  private async renglonesDeOrden(
    orderId: string,
  ): Promise<PurchaseOrderItemResponseDto[]> {
    const filas: Array<{
      item_id: string;
      gas_cylinder_id: string;
      type: string;
      quantity: number;
      unit_cost: string;
      empties_to_exchange: number;
      received_quantity: number;
    }> = await this.dataSource.query(
      `SELECT i."item_id", i."gas_cylinder_id", g."type", i."quantity", i."unit_cost",
              i."empties_to_exchange", i."received_quantity"
       FROM "purchase_order_item" i
       JOIN "gas_cylinder" g ON g."gas_cylinder_id" = i."gas_cylinder_id"
       WHERE i."purchase_order_id" = $1
       ORDER BY g."type"`,
      [orderId],
    );
    return filas.map((f) =>
      Object.assign(new PurchaseOrderItemResponseDto(), {
        itemId: f.item_id,
        gasCylinderId: f.gas_cylinder_id,
        gasCylinderType: f.type,
        quantity: f.quantity,
        unitCost: Number(f.unit_cost),
        subtotal: redondear(Number(f.unit_cost) * f.quantity),
        emptiesToExchange: f.empties_to_exchange,
        receivedQuantity: f.received_quantity,
        pendingQuantity: Math.max(0, f.quantity - f.received_quantity),
      }),
    );
  }

  private async paginaDeRecepciones(
    where: string[],
    params: unknown[],
    page: number | undefined,
    limitSolicitado: number | undefined,
  ): Promise<PurchaseReceiptPageDto> {
    const { limit, offset } = this.pagina(page, limitSolicitado);
    const [{ total }]: Array<{ total: string }> = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM "purchase_receipt" r WHERE ${where.join(' AND ')}`,
      params,
    );
    const filas: FilaDeRecepcion[] = await this.dataSource.query(
      `${SELECT_RECEPCION} WHERE ${where.join(' AND ')}
       ORDER BY r."received_at" DESC, r."number" DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return {
      data: filas.map((f) => this.aResumenDeRecepcion(f)),
      total: Number(total),
    };
  }

  private pagina(page = 1, limit = 10): { limit: number; offset: number } {
    return { limit, offset: (page - 1) * limit };
  }

  private filtroDeFechas(
    where: string[],
    params: unknown[],
    columna: string,
    from: string | undefined,
    to: string | undefined,
  ): void {
    if (!from && !to) return;
    const rango = rangoDeDiasArgentinos((from ?? to)!, (to ?? from)!);
    if (!rango)
      throw new BadRequestException('Las fechas tienen que ser YYYY-MM-DD');
    if (rango.desde >= rango.hasta) {
      throw new BadRequestException('"from" no puede ser posterior a "to"');
    }
    params.push(rango.desde, rango.hasta);
    where.push(
      `${columna} >= $${params.length - 1} AND ${columna} < $${params.length}`,
    );
  }

  private aResumenDeOrden(f: FilaDeOrden): PurchaseOrderSummaryDto {
    return Object.assign(new PurchaseOrderSummaryDto(), {
      purchaseOrderId: f.purchase_order_id,
      number: f.number,
      supplierId: f.supplier_id,
      supplierName: f.supplier_name,
      destinationWarehouseId: f.destination_warehouse_id,
      destinationWarehouseName: f.warehouse_name,
      status: f.status,
      issuedAt: f.issued_at,
      expectedDate: f.expected_date,
      totalAmount: Number(f.total_amount),
      cancelReason: f.cancel_reason,
      closeReason: f.close_reason,
      notes: f.notes,
      orderedQuantity: f.ordered,
      receivedQuantity: f.received,
      pendingQuantity: SIN_PENDIENTE.includes(f.status)
        ? 0
        : Math.max(0, f.ordered - f.received),
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    });
  }

  private aResumenDeRecepcion(f: FilaDeRecepcion): PurchaseReceiptSummaryDto {
    return Object.assign(new PurchaseReceiptSummaryDto(), {
      receiptId: f.receipt_id,
      number: f.number,
      supplierId: f.supplier_id,
      supplierName: f.supplier_name,
      purchaseOrderId: f.purchase_order_id,
      purchaseOrderNumber: f.po_number,
      warehouseId: f.warehouse_id,
      warehouseName: f.warehouse_name,
      supplierDocumentType: f.supplier_document_type,
      supplierDocumentNumber: f.supplier_document_number,
      receivedAt: f.received_at,
      totalAmount: Number(f.total_amount),
      paymentStatus: f.payment_status,
      status: f.status,
    });
  }
}

const redondear = (n: number): number => Math.round(n * 100) / 100;
