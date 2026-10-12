import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentSequenceModule } from '../document-sequence/document-sequence.module';
import { GasCylinderModule } from '../gascylinder/gascylinder.module';
import { StockModule } from '../stock/stock.module';
import { PurchaseOrderService } from './application/purchase-order.service';
import { PurchaseQueryService } from './application/purchase-query.service';
import { PurchaseReceiptService } from './application/purchase-receipt.service';
import { ReceivePurchaseUseCase } from './application/receive-purchase.use-case';
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
  ],
  controllers: [
    SupplierController,
    PurchaseOrderController,
    PurchaseReceiptController,
  ],
  providers: [
    SupplierService,
    PurchaseOrderService,
    PurchaseReceiptService,
    ReceivePurchaseUseCase,
    VoidPurchaseReceiptUseCase,
    PurchaseQueryService,
  ],
})
export class PurchaseModule {}
