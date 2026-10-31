import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomersModule } from '../customer/customer.module';
import { GasCylinderModule } from '../gascylinder/gascylinder.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { OrderLookupModule } from '../order/lookup/order-lookup.module';
import { OrderModule } from '../order/order.module';
import { TimeSlotModule } from '../time-slot/time-slot.module';
import { UserAddressModule } from '../user-address/user-address.module';
import { RepurchaseInvitation } from './entities/repurchase-invitation.entity';
import { RepurchaseAcceptService } from './repurchase-accept.service';
import { RepurchaseAdminController } from './repurchase-admin.controller';
import { RepurchaseCron } from './repurchase.cron';
import { RepurchaseCustomerController } from './repurchase-customer.controller';
import { RepurchaseCustomerService } from './repurchase-customer.service';
import { RepurchaseEstimatorService } from './repurchase-estimator.service';
import { RepurchaseForecastService } from './repurchase-forecast.service';
import { RepurchaseInvitationDetailService } from './repurchase-invitation-detail.service';
import { RepurchaseInvitationService } from './repurchase-invitation.service';
import { RepurchaseNotifier } from './repurchase-notifier';
import { RepurchaseReportService } from './repurchase-report.service';
import { RepurchaseSuggestionService } from './repurchase-suggestion.service';

/**
 * Recompra anticipada (CU-106, CU-145 y CU-146; módulo inteligente M3): estima
 * cuándo se le acaba el gas a cada cliente con sus compras, le abre una
 * invitación con el pedido precargado y, si la acepta, lo crea por el camino
 * normal de pedidos. Vive aparte de `RepurchaseModule` (consumo declarado)
 * porque necesita crear pedidos: `order` no puede depender de él, ni el
 * registro de este.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([RepurchaseInvitation]),
    CustomersModule, // fichas del cliente: consumo declarado y preferencia de aviso
    OrderModule, // el pedido de una invitación aceptada nace por OrderService.create
    OrderLookupModule, // compras entregadas y pedidos vigentes de cada cliente
    GasCylinderModule, // catálogo: precio y stock de hoy
    TimeSlotModule, // la franja habitual sigue activa
    UserAddressModule, // la dirección sigue existiendo
    GatewaysModule, // la invitación le llega al cliente por el socket
  ],
  controllers: [RepurchaseAdminController, RepurchaseCustomerController],
  providers: [
    RepurchaseEstimatorService,
    RepurchaseSuggestionService,
    RepurchaseInvitationService,
    RepurchaseInvitationDetailService,
    RepurchaseForecastService,
    RepurchaseAcceptService,
    RepurchaseCustomerService,
    RepurchaseReportService,
    RepurchaseNotifier,
    RepurchaseCron,
  ],
})
export class RepurchaseForecastModule {}
