import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttachmentModule } from '../attachment/attachment.module';
import { CarModule } from '../car/car.module';
import { CashModule } from '../cash/cash.module';
import { DistributorModule } from '../distributor/distributor.module';
import { FleetModule } from '../fleet/fleet.module';
import { InsuranceAlertsCron } from './application/insurance-alerts.cron';
import {
  InsuranceInstallmentAttachmentOwnerResolver,
  InsurancePolicyAttachmentOwnerResolver,
} from './application/insurance-attachment-owners';
import { InsuranceInstallmentService } from './application/insurance-installment.service';
import { InsurancePolicyService } from './application/insurance-policy.service';
import { InsuranceQueryService } from './application/insurance-query.service';
import { InsurerService } from './application/insurer.service';
import { InsuranceInstallment } from './entities/insurance-installment.entity';
import { InsurancePolicy } from './entities/insurance-policy.entity';
import { Insurer } from './entities/insurer.entity';
import { InsuranceInstallmentController } from './presentation/insurance-installment.controller';
import { InsurancePolicyController } from './presentation/insurance-policy.controller';
import { InsurerController } from './presentation/insurer.controller';

/**
 * Seguros de los vehículos (F14, API v2): aseguradoras, pólizas con su plan de
 * cuotas, comprobante que se escanea al subirlo, pago como egreso de caja y
 * avisos de vencimiento. La tarea de seguro de la flota se mantiene con
 * `FleetInsuranceSyncService`; el dinero sale por `CashDocumentPaymentService`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Insurer, InsurancePolicy, InsuranceInstallment]),
    CarModule, // el vehículo existe y es de la distribuidora
    CashModule, // el pago sale de una caja
    FleetModule, // la tarea de seguro del vehículo
    AttachmentModule, // el comprobante es un adjunto de la cuota
    DistributorModule, // a qué hora avisa cada distribuidora
  ],
  controllers: [
    InsurerController,
    InsurancePolicyController,
    InsuranceInstallmentController,
  ],
  providers: [
    InsurerService,
    InsurancePolicyService,
    InsuranceInstallmentService,
    InsuranceQueryService,
    InsuranceAlertsCron,
    InsurancePolicyAttachmentOwnerResolver,
    InsuranceInstallmentAttachmentOwnerResolver,
  ],
  exports: [InsuranceInstallmentService, InsurancePolicyService],
})
export class InsuranceModule {}
