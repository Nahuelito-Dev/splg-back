import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomersModule } from '../../customer/customer.module';
import { DeliveryModule } from '../../delivery/delivery.module';
import { DistributorModule } from '../../distributor/distributor.module';
import { GatewaysModule } from '../../gateways/gateways.module';
import { OrderLookupModule } from '../../order/lookup/order-lookup.module';
import { CylinderModule } from '../cylinder.module';
import { CylinderRecoveryCase } from '../entities/cylinder-recovery-case.entity';
import { CylinderRecoveryNotice } from '../entities/cylinder-recovery-notice.entity';
import { CylinderRecoveryCasesService } from './cylinder-recovery-cases.service';
import {
  CylinderRecoveryAdminController,
  CylinderRecoveryCustomerController,
  CylinderRecoveryDriverController,
} from './cylinder-recovery.controllers';
import { CylinderRecoveryCron } from './cylinder-recovery.cron';
import { CylinderRecoveryListener } from './cylinder-recovery.listener';
import { CylinderRecoveryNotifier } from './cylinder-recovery.notifier';
import { CylinderRecoveryService } from './cylinder-recovery.service';

/**
 * Recuperación de envases no devueltos (CU-108, módulo inteligente M5): detecta
 * los envases que siguen en poder de un cliente pasada la tolerancia, los hace
 * avanzar por los escalones de aviso y deja el legajo al administrador, que es
 * el único que cobra el depósito o da de baja el envase.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CylinderRecoveryCase, CylinderRecoveryNotice]),
    CylinderModule,
    DistributorModule,
    OrderLookupModule,
    DeliveryModule,
    CustomersModule,
    GatewaysModule,
  ],
  controllers: [
    CylinderRecoveryAdminController,
    CylinderRecoveryCustomerController,
    CylinderRecoveryDriverController,
  ],
  providers: [
    CylinderRecoveryService,
    CylinderRecoveryCasesService,
    CylinderRecoveryNotifier,
    CylinderRecoveryCron,
    CylinderRecoveryListener,
  ],
})
export class CylinderRecoveryModule {}
