import { PurchaseQueryService } from '../../purchase/application/purchase-query.service';
import { SupplierService } from '../../purchase/application/supplier.service';
import { QueryPurchaseOrderDto } from '../../purchase/dto/purchase-order.dto';
import type { PurchaseOrderSummaryDto } from '../../purchase/dto/purchase-order.dto';
import { QueryPurchaseReceiptDto } from '../../purchase/dto/purchase-receipt.dto';
import type { PurchaseReceiptSummaryDto } from '../../purchase/dto/purchase-receipt.dto';
import { QuerySupplierDto } from '../../purchase/dto/supplier.dto';
import type { SupplierResponseDto } from '../../purchase/dto/supplier.dto';
import { SupplierMapper } from '../../purchase/presentation/supplier.mapper';
import type { FuenteDeExporte } from '../export.types';
import {
  booleano,
  codigo,
  entero,
  fecha,
  fechaHora,
  moneda,
  opcion,
  texto,
} from './columnas';
import { fuente, porPagina } from './fuente';

export interface ServiciosDeCompras {
  purchases: PurchaseQueryService;
  suppliers: SupplierService;
}

export function fuentesDeCompras(s: ServiciosDeCompras): FuenteDeExporte[] {
  return [
    fuente<QueryPurchaseOrderDto, PurchaseOrderSummaryDto>({
      recurso: 'ordenes-compra',
      descripcion:
        'Órdenes de compra (mismos filtros que GET /purchase-orders)',
      query: QueryPurchaseOrderDto,
      paginar: porPagina,
      leer: async (query, distribuidoraId) => {
        const r = await s.purchases.ordenes(distribuidoraId, query);
        return { filas: r.data, total: r.total };
      },
      columnas: [
        entero('N°', (o) => o.number),
        texto('Proveedor', (o) => o.supplierName),
        texto('Depósito de destino', (o) => o.destinationWarehouseName),
        opcion('Estado', 'status', (o) => o.status),
        fechaHora('Emitida', (o) => o.issuedAt),
        fecha('Entrega esperada', (o) => o.expectedDate),
        entero('Unidades pedidas', (o) => o.orderedQuantity),
        entero('Unidades recibidas', (o) => o.receivedQuantity),
        entero('Unidades pendientes', (o) => o.pendingQuantity),
        moneda('Total', (o) => o.totalAmount),
        texto('Motivo de cancelación', (o) => o.cancelReason, 36),
        texto('Motivo de cierre', (o) => o.closeReason, 36),
        texto('Notas', (o) => o.notes, 36),
        fechaHora('Alta', (o) => o.createdAt),
      ],
    }),

    fuente<QueryPurchaseReceiptDto, PurchaseReceiptSummaryDto>({
      recurso: 'recepciones',
      descripcion:
        'Recepciones de mercadería (mismos filtros que GET /purchase-receipts)',
      query: QueryPurchaseReceiptDto,
      paginar: porPagina,
      leer: async (query, distribuidoraId) => {
        const r = await s.purchases.recepciones(distribuidoraId, query);
        return { filas: r.data, total: r.total };
      },
      columnas: [
        entero('N°', (r) => r.number),
        fechaHora('Recibida', (r) => r.receivedAt),
        texto('Proveedor', (r) => r.supplierName),
        entero('Orden de compra', (r) => r.purchaseOrderNumber),
        texto('Depósito', (r) => r.warehouseName),
        opcion(
          'Tipo de comprobante',
          'supplierDocumentType',
          (r) => r.supplierDocumentType,
        ),
        codigo('N° de comprobante', (r) => r.supplierDocumentNumber),
        moneda('Total', (r) => r.totalAmount),
        opcion('Estado del pago', 'paymentStatus', (r) => r.paymentStatus),
        opcion('Estado', 'status', (r) => r.status),
      ],
    }),

    fuente<QuerySupplierDto, SupplierResponseDto>({
      recurso: 'proveedores',
      descripcion: 'Proveedores (mismos filtros que GET /suppliers)',
      query: QuerySupplierDto,
      paginar: porPagina,
      leer: async (query, distribuidoraId) => {
        const r = await s.suppliers.findAll(distribuidoraId, query);
        return {
          filas: r.data.map((p) => SupplierMapper.toDto(p)),
          total: r.total,
        };
      },
      columnas: [
        texto('Razón social', (p) => p.businessName),
        codigo('CUIT', (p) => p.cuit),
        opcion('Rubro', 'kind', (p) => p.kind),
        texto('Contacto', (p) => p.contactName),
        codigo('Teléfono', (p) => p.phone),
        texto('Email', (p) => p.email),
        texto('Dirección', (p) => p.address, 36),
        entero('Plazo de pago (días)', (p) => p.paymentTermsDays),
        booleano('Activo', (p) => p.isActive),
        fechaHora('Alta', (p) => p.createdAt),
      ],
    }),
  ];
}
