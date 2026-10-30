import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttachmentModule } from '../attachment/attachment.module';
import { CashModule } from '../cash/cash.module';
import { S3Module } from '../s3/s3.module';
import { MpLedgerReader } from './application/mp-ledger.reader';
import { MpReconciliationApplyService } from './application/mp-reconciliation-apply.service';
import { MpReconciliationAttachmentOwnerResolver } from './application/mp-reconciliation-attachment-owner.resolver';
import { MpReconciliationCron } from './application/mp-reconciliation.cron';
import { MpReconciliationService } from './application/mp-reconciliation.service';
import { MercadoPagoReportsPort } from './domain/mp-reports.port';
import { FakeMercadoPagoReportsAdapter } from './infrastructure/fake-mercadopago-reports.adapter';
import { MercadoPagoReportsAdapter } from './infrastructure/mercadopago-reports.adapter';
import { MpReconciliationItem } from './entities/mp-reconciliation-item.entity';
import { MpReconciliation } from './entities/mp-reconciliation.entity';
import { MpReconciliationController } from './presentation/mp-reconciliation.controller';

/**
 * Conciliación de la caja de Mercado Pago con el reporte de liberaciones
 * (caja completa, etapa 4). Se apoya en `CashModule` para asentar los ajustes y
 * en `AttachmentModule` para guardar el reporte. `MP_REPORTS_DRIVER=fake` usa un
 * reporte de mentira (sólo fuera de producción) para probar sin tocar la cuenta.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([MpReconciliation, MpReconciliationItem]),
    CashModule,
    AttachmentModule,
    S3Module,
  ],
  controllers: [MpReconciliationController],
  providers: [
    MpLedgerReader,
    MpReconciliationService,
    MpReconciliationApplyService,
    MpReconciliationCron,
    MpReconciliationAttachmentOwnerResolver,
    {
      provide: MercadoPagoReportsPort,
      inject: [ConfigService],
      useFactory: (config: ConfigService): MercadoPagoReportsPort => {
        if (config.get<string>('MP_REPORTS_DRIVER') === 'fake') {
          const entorno = config.get<string>('NODE_ENV');
          if (entorno !== 'development' && entorno !== 'test') {
            throw new Error(
              'MP_REPORTS_DRIVER=fake sólo se admite con NODE_ENV=development o test',
            );
          }
          return new FakeMercadoPagoReportsAdapter(config);
        }
        return new MercadoPagoReportsAdapter(config);
      },
    },
  ],
})
export class MpReconciliationModule {}
