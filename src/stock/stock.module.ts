import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { AttachmentModule } from '../attachment/attachment.module';
import { CarModule } from '../car/car.module';
import { DocumentSequenceModule } from '../document-sequence/document-sequence.module';
import { EmailModule } from '../email/email.module';
import { GasCylinderModule } from '../gascylinder/gascylinder.module';
import { StockDeliveryPort } from '../order/domain/ports/stock-delivery.port';
import { OrderLookupModule } from '../order/lookup/order-lookup.module';
import { CatalogStockAdjustmentUseCase } from './application/catalog-stock-adjustment.use-case';
import { GarrafaCreadaListener } from './application/garrafa-creada.listener';
import { InitialCountUseCase } from './application/initial-count.use-case';
import { ReapplyDeliveriesUseCase } from './application/reapply-deliveries.use-case';
import { ReverseBatchUseCase } from './application/reverse-batch.use-case';
import { StockAdjustmentUseCase } from './application/stock-adjustment.use-case';
import { StockAdjustmentAttachmentOwnerResolver } from './application/stock-adjustment-attachment-owner.resolver';
import { StockAdminNotifier } from './application/stock-admin-notifier.service';
import { StockDeliveryService } from './application/stock-delivery.service';
import { StockLedgerService } from './application/stock-ledger.service';
import { StockLocationService } from './application/stock-location.service';
import { StockLowCron } from './application/stock-low.cron';
import { StockOnHandService } from './application/stock-on-hand.service';
import { StockQueryService } from './application/stock-query.service';
import { StockReconciliationCron } from './application/stock-reconciliation.cron';
import { StockReconciliationService } from './application/stock-reconciliation.service';
import { StockThresholdService } from './application/stock-threshold.service';
import { StockTransferUseCase } from './application/stock-transfer.use-case';
import { WarehouseSeedListener } from './application/warehouse-seed.listener';
import { WarehouseService } from './application/warehouse.service';
import { StockLedgerPort } from './domain/ports/stock-ledger.port';
import { StockAdjustment } from './entities/stock-adjustment.entity';
import { StockReconciliationAlert } from './entities/stock-reconciliation-alert.entity';
import { ReconciliationAdjustmentUseCase } from './application/reconciliation-adjustment.use-case';
import { StockAdjustmentItem } from './entities/stock-adjustment-item.entity';
import { StockBalance } from './entities/stock-balance.entity';
import { StockLocation } from './entities/stock-location.entity';
import { StockMovement } from './entities/stock-movement.entity';
import { StockThreshold } from './entities/stock-threshold.entity';
import { Warehouse } from './entities/warehouse.entity';
import { CatalogStockController } from './presentation/catalog-stock.controller';
import { StockController } from './presentation/stock.controller';
import { WarehouseController } from './presentation/warehouse.controller';

/**
 * Stock físico (M-C, parte 1): depósitos, ubicaciones (depósito o vehículo),
 * saldos, libro de movimientos, conteo inicial, ajustes, transferencias,
 * umbrales y conciliación del vendible.
 *
 * `StockLedgerPort` es el ÚNICO que mueve stock; lo exporta para las compras y
 * la carga del camión (partes 2 y 3). `StockDeliveryPort` es lo que el pedido
 * llama al entregarse.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Warehouse,
      StockLocation,
      StockBalance,
      StockMovement,
      StockThreshold,
      StockAdjustment,
      StockAdjustmentItem,
      StockReconciliationAlert,
    ]),
    GasCylinderModule, // el vendible (`gas_cylinder.stock`) lo mantiene su servicio
    CarModule, // "el vehículo existe y es de esta distribuidora"
    DocumentSequenceModule, // número de ajuste
    OrderLookupModule, // reservado por pedidos abiertos y entregas
    AdminModule, // a quién avisar
    EmailModule, // cómo avisar
    AttachmentModule, // dueño `stock_adjustment` de los adjuntos
  ],
  controllers: [WarehouseController, StockController, CatalogStockController],
  providers: [
    StockLedgerService,
    { provide: StockLedgerPort, useExisting: StockLedgerService },
    StockDeliveryService,
    { provide: StockDeliveryPort, useExisting: StockDeliveryService },
    WarehouseService,
    StockLocationService,
    StockQueryService,
    StockOnHandService,
    StockThresholdService,
    StockReconciliationService,
    StockAdjustmentUseCase,
    InitialCountUseCase,
    StockTransferUseCase,
    ReverseBatchUseCase,
    ReapplyDeliveriesUseCase,
    ReconciliationAdjustmentUseCase,
    CatalogStockAdjustmentUseCase,
    StockAdjustmentAttachmentOwnerResolver,
    StockAdminNotifier,
    StockLowCron,
    StockReconciliationCron,
    WarehouseSeedListener,
    GarrafaCreadaListener,
  ],
  exports: [
    StockLedgerPort,
    StockDeliveryPort,
    WarehouseService,
    StockLocationService,
    StockOnHandService,
  ],
})
export class StockModule {}
