import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CarModule } from '../car/car.module';
import { CashModule } from '../cash/cash.module';
import { ClaimsModule } from '../claims/claims.module';
import { CommissionModule } from '../commission/commission.module';
import { CustomerAccountModule } from '../customer-account/customer-account.module';
import { CustomersModule } from '../customer/customer.module';
import { CylinderModule } from '../cylinder/cylinder.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { DriverSettlementModule } from '../driver-settlement/driver-settlement.module';
import { EmployeeModule } from '../employee/employee.module';
import { FleetExpenseModule } from '../fleet-expense/fleet-expense.module';
import { GasCylinderModule } from '../gascylinder/gascylinder.module';
import { IncidentModule } from '../incident/incident.module';
import { OrderModule } from '../order/order.module';
import { PurchaseModule } from '../purchase/purchase.module';
import { StockModule } from '../stock/stock.module';
import { ExportSourcesRegistry } from './export-sources.registry';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

/**
 * Exportes completos en CSV y Excel. Es un modelo de lectura: no tiene datos
 * propios, sólo usa los servicios de listado de cada módulo.
 */
@Module({
  imports: [
    OrderModule,
    CustomersModule,
    DeliveryModule,
    CarModule,
    GasCylinderModule,
    CylinderModule,
    StockModule,
    CashModule,
    CustomerAccountModule,
    DriverSettlementModule,
    CommissionModule,
    FleetExpenseModule,
    ClaimsModule,
    IncidentModule,
    PurchaseModule,
    EmployeeModule,
    AuditModule,
  ],
  controllers: [ExportsController],
  providers: [ExportsService, ExportSourcesRegistry],
})
export class ExportsModule {}
