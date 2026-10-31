import { Module } from '@nestjs/common';
import { CustomersModule } from '../customer/customer.module';
import { GasCylinderModule } from '../gascylinder/gascylinder.module';
import { OrderLookupModule } from '../order/lookup/order-lookup.module';
import { ConsumptionController } from './consumption.controller';
import { ConsumptionDeliveredListener } from './consumption-delivered.listener';
import { ConsumptionService } from './consumption.service';

/**
 * Consumo declarado y estimación de recompra. Depende de `customer` (dueño de
 * los campos) y de la lectura de pedidos; `order` no lo importa.
 */
@Module({
  imports: [CustomersModule, GasCylinderModule, OrderLookupModule],
  controllers: [ConsumptionController],
  providers: [ConsumptionService, ConsumptionDeliveredListener],
  exports: [ConsumptionService],
})
export class RepurchaseModule {}
