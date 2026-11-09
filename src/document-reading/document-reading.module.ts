import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Attachment } from '../attachment/entities/attachment.entity';
import { S3Module } from '../s3/s3.module';

import { DocumentReadingController } from './document-reading.controller';
import { DocumentReadingService } from './document-reading.service';
import { DocumentReading } from './entities/document-reading.entity';
import { DocumentReadingSettingsService } from './document-reading-settings.service';
import { DocumentReadingQueueService } from './document-reading-queue.service';
import { DocumentReadingRunnerService } from './document-reading-runner.service';
import { DocumentReadingCron } from './document-reading.cron';
import { DocumentReadingProposalService } from './document-reading-proposal.service';
import { DocumentReadingProposalCron } from './document-reading-proposal.cron';
import { DocumentReconciliationService } from './document-reconciliation.service';
import { InsuranceInstallment } from '../insurance/entities/insurance-installment.entity';
import { TrafficFine } from '../fleet-expense/entities/traffic-fine.entity';
import { InsurancePolicy } from '../insurance/entities/insurance-policy.entity';
import { Car } from '../car/entities/car.entity';
import { PurchaseReceipt } from '../purchase/entities/purchase-receipt.entity';
import { PurchaseOrder } from '../purchase/entities/purchase-order.entity';
import { Supplier } from '../purchase/entities/supplier.entity';
import { Employee } from '../employee/entities/employee.entity';
import { DocumentReadingExample } from './entities/document-reading-example.entity';
import { DocumentReadingDecisionService } from './document-reading-decision.service';
import { InsuranceModule } from '../insurance/insurance.module';
import { FleetExpenseModule } from '../fleet-expense/fleet-expense.module';
import { FleetModule } from '../fleet/fleet.module';
import { PurchaseModule } from '../purchase/purchase.module';

/**
 * Lecturas de documentos del módulo M6 (lo que se extrajo de cada adjunto).
 * Global: el escaneo de comprobantes y el proceso automático las usan.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DocumentReading,
      DocumentReadingExample,
      Attachment,
      InsuranceInstallment,
      TrafficFine,
      InsurancePolicy,
      Car,
      PurchaseReceipt,
      PurchaseOrder,
      Supplier,
      Employee,
    ]),
    S3Module,
    InsuranceModule,
    FleetExpenseModule,
    FleetModule,
    PurchaseModule,
  ],
  controllers: [DocumentReadingController],
  providers: [
    DocumentReadingService,
    DocumentReadingSettingsService,
    DocumentReadingQueueService,
    DocumentReadingRunnerService,
    DocumentReadingCron,
    DocumentReconciliationService,
    DocumentReadingProposalService,
    DocumentReadingProposalCron,
    DocumentReadingDecisionService,
  ],
  exports: [
    DocumentReadingService,
    DocumentReadingRunnerService,
    DocumentReadingProposalService,
  ],
})
export class DocumentReadingModule {}
