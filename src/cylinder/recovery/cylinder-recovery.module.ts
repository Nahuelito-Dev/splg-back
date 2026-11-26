import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomersModule } from '../../customer/customer.module';
import { CustomerContainerModule } from '../../customer-container/customer-container.module';
import { DeliveryModule } from '../../delivery/delivery.module';
import { DistributorModule } from '../../distributor/distributor.module';
import { GatewaysModule } from '../../gateways/gateways.module';
import { OrderLookupModule } from '../../order/lookup/order-lookup.module';
import { CylinderModule } from '../cylinder.module';
import { CylinderRecoveryCase } from '../entities/cylinder-recovery-case.entity';
import { CylinderRecoveryNotice } from '../entities/cylinder-recovery-notice.entity';
import { CustomerRecoveryScore } from '../entities/customer-recovery-score.entity';
import { CylinderRecoveryCasesService } from './cylinder-recovery-cases.service';
import {
  CylinderRecoveryAdminController,
  CylinderRecoveryCustomerController,
  CylinderRecoveryDriverController,
} from './cylinder-recovery.controllers';
import { CylinderRecoveryScoreController } from './cylinder-recovery-v3.controller';
import { CylinderRecoveryCron } from './cylinder-recovery.cron';
import { CylinderRecoveryHojaListener } from './cylinder-recovery-hoja.listener';
import { CylinderRecoveryListener } from './cylinder-recovery.listener';
import { CylinderRecoveryPickupOpportunityService } from './cylinder-recovery-pickup-opportunity.service';
import { CylinderRecoveryNotifier } from './cylinder-recovery.notifier';
import { CylinderRecoveryService } from './cylinder-recovery.service';
import { CylinderRecoveryAccountService } from './cylinder-recovery-account.service';

/**
 * Recuperación de envases no devueltos (CU-108, módulo inteligente M5): detecta
 * los envases que siguen en poder de un cliente pasada la tolerancia, los hace
 * avanzar por los escalones de aviso y deja el legajo al administrador, que es
 * el único que cobra el depósito o da de baja el envase.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CylinderRecoveryCase,
      CylinderRecoveryNotice,
      CustomerRecoveryScore,
    ]),
    CylinderModule,
    DistributorModule,
    OrderLookupModule,
    DeliveryModule,
    CustomersModule,
    CustomerContainerModule,
    GatewaysModule,
  ],
  controllers: [
    CylinderRecoveryAdminController,
    CylinderRecoveryScoreController,
    CylinderRecoveryCustomerController,
    CylinderRecoveryDriverController,
  ],
  providers: [
    CylinderRecoveryService,
    CylinderRecoveryAccountService,
    CylinderRecoveryCasesService,
    CylinderRecoveryNotifier,
    CylinderRecoveryCron,
    CylinderRecoveryListener,
    CylinderRecoveryPickupOpportunityService,
    CylinderRecoveryHojaListener,
  ],
})
export class CylinderRecoveryModule {}
