import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CashModule } from '../cash/cash.module';
import { AttachmentModule } from '../attachment/attachment.module';
import { DocumentSequenceModule } from '../document-sequence/document-sequence.module';
import { GasCylinderModule } from '../gascylinder/gascylinder.module';
import { S3Module } from '../s3/s3.module';
import { StockModule } from '../stock/stock.module';
import { PurchaseOrderService } from './application/purchase-order.service';
import { PurchaseReceiptAttachmentOwnerResolver } from './application/purchase-receipt-attachment-owner.resolver';
import { PurchaseQueryService } from './application/purchase-query.service';
import { PurchaseReceiptService } from './application/purchase-receipt.service';
import { ReceivePurchaseUseCase } from './application/receive-purchase.use-case';
import { SupplierPhotoService } from './application/supplier-photo.service';
import { SupplierService } from './application/supplier.service';
import { VoidPurchaseReceiptUseCase } from './application/void-purchase-receipt.use-case';
import { PurchaseOrderItem } from './entities/purchase-order-item.entity';
import { PurchaseOrder } from './entities/purchase-order.entity';
import { PurchaseReceiptItem } from './entities/purchase-receipt-item.entity';
import { PurchaseReceipt } from './entities/purchase-receipt.entity';
import { Supplier } from './entities/supplier.entity';
import { PurchaseOrderController } from './presentation/purchase-order.controller';
import { PurchaseReceiptController } from './presentation/purchase-receipt.controller';
import { SupplierController } from './presentation/supplier.controller';
import { SupplierPhotoController } from './presentation/supplier-photo.controller';

/**
 * Compras (M-C, parte 2): proveedores, órdenes de compra y recepciones. La
 * entrada y salida de garrafas pasa SIEMPRE por `StockLedgerPort`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Supplier,
      PurchaseOrder,
      PurchaseOrderItem,
      PurchaseReceipt,
      PurchaseReceiptItem,
    ]),
    StockModule, // ledger, ubicaciones, depósitos y existencias
    GasCylinderModule, // costo promedio
    DocumentSequenceModule, // número de la orden y del remito
    AttachmentModule, // dueño `purchase_receipt` de los adjuntos
    CashModule, // el pago en efectivo sale de una caja por el libro
    S3Module, // foto del proveedor
  ],
  controllers: [
    SupplierController,
    SupplierPhotoController,
    PurchaseOrderController,
    PurchaseReceiptController,
  ],
  providers: [
    SupplierService,
    SupplierPhotoService,
    PurchaseOrderService,
    PurchaseReceiptService,
    ReceivePurchaseUseCase,
    VoidPurchaseReceiptUseCase,
    PurchaseQueryService,
    PurchaseReceiptAttachmentOwnerResolver,
  ],
  // SupplierService: la importación masiva da de alta proveedores.
  exports: [PurchaseQueryService, SupplierService],
})
export class PurchaseModule {}
