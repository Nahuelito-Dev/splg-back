import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CarModule } from '../car/car.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { DocumentSequenceModule } from '../document-sequence/document-sequence.module';
import { EmployeeModule } from '../employee/employee.module';
import { TruckLoadGatePort } from '../order/domain/ports/truck-load-gate.port';
import { OrderLookupModule } from '../order/lookup/order-lookup.module';
import { StockModule } from '../stock/stock.module';
import { CancelTruckLoadUseCase } from './application/cancel-truck-load.use-case';
import { CloseTruckLoadUseCase } from './application/close-truck-load.use-case';
import { DepartTruckLoadUseCase } from './application/depart-truck-load.use-case';
import { OpenTruckLoadUseCase } from './application/open-truck-load.use-case';
import { ReloadTruckLoadUseCase } from './application/reload-truck-load.use-case';
import { ReturnTruckLoadUseCase } from './application/return-truck-load.use-case';
import { StockControlSettingsService } from './application/stock-control-settings.service';
import { TruckLoadAccessService } from './application/truck-load-access.service';
import { TruckLoadGateService } from './application/truck-load-gate.service';
import { TruckLoadQueryService } from './application/truck-load-query.service';
import { UpdateTruckLoadItemsUseCase } from './application/update-truck-load-items.use-case';
import { TruckLoadItem } from './entities/truck-load-item.entity';
import { TruckLoad } from './entities/truck-load.entity';
import { TruckLoadController } from './presentation/truck-load.controller';

/**
 * Carga y rendición del camión (M-C, parte 3). Toda salida y entrada de
 * garrafas pasa por `StockLedgerPort`; este módulo guarda el documento
 * (`truck_load` y sus renglones) y las reglas de la jornada. Exporta el puerto
 * con el que el despacho consulta si el chofer tiene carga abierta (D5).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TruckLoad, TruckLoadItem]),
    StockModule, // ledger, ubicaciones, depósitos, saldos y libro
    CarModule, // el camión en uso por el chofer
    DeliveryModule, // el chofer
    EmployeeModule, // el ayudante (legajo)
    DocumentSequenceModule, // número de la carga
    OrderLookupModule, // pedidos entregados y su cobro
  ],
  controllers: [TruckLoadController],
  providers: [
    StockControlSettingsService,
    TruckLoadAccessService,
    TruckLoadQueryService,
    OpenTruckLoadUseCase,
    UpdateTruckLoadItemsUseCase,
    DepartTruckLoadUseCase,
    ReloadTruckLoadUseCase,
    ReturnTruckLoadUseCase,
    CloseTruckLoadUseCase,
    CancelTruckLoadUseCase,
    TruckLoadGateService,
    { provide: TruckLoadGatePort, useExisting: TruckLoadGateService },
  ],
  exports: [TruckLoadGatePort],
})
export class TruckLoadModule {}
