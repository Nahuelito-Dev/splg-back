import { Module } from '@nestjs/common';
import { CashModule } from '../cash/cash.module';
import { CommissionModule } from '../commission/commission.module';
import { DistributorModule } from '../distributor/distributor.module';
import { DriverSettlementModule } from '../driver-settlement/driver-settlement.module';
import { OrderModule } from '../order/order.module';
import { ReportsModule } from '../reports/reports.module';
import { S3Module } from '../s3/s3.module';
import { PdfBrandingService } from './pdf-branding.service';
import { PdfController } from './pdf.controller';
import { PdfDocumentsService } from './pdf-documents.service';

/**
 * Documentos PDF (API v2). Sólo lee: cada documento sale de los servicios que
 * ya exportan los módulos dueños del dato, así hereda su aislamiento por
 * distribuidora y sus reglas de acceso.
 */
@Module({
  imports: [
    OrderModule,
    DriverSettlementModule,
    CommissionModule,
    CashModule,
    ReportsModule,
    DistributorModule,
    S3Module,
  ],
  controllers: [PdfController],
  providers: [PdfDocumentsService, PdfBrandingService],
})
export class PdfModule {}
