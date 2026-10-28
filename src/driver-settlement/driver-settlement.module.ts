import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { CashModule } from '../cash/cash.module';
import { CommissionModule } from '../commission/commission.module';
import { DocumentSequenceModule } from '../document-sequence/document-sequence.module';
import { EmailModule } from '../email/email.module';
import { RedisModule } from '../redis/redis.module';
import { DriverSettlementCron } from './application/driver-settlement.cron';
import { DriverSettlementQueryService } from './application/driver-settlement-query.service';
import { AttachmentModule } from '../attachment/attachment.module';
import { DriverSettlementAttachmentOwnerResolver } from './application/driver-settlement-attachment-owner.resolver';
import { DriverSettlementService } from './application/driver-settlement.service';
import { DriverSettlementCollection } from './entities/driver-settlement-collection.entity';
import { DriverSettlementExpense } from './entities/driver-settlement-expense.entity';
import { DriverSettlementOrder } from './entities/driver-settlement-order.entity';
import { DriverSettlement } from './entities/driver-settlement.entity';
import { DriverSettlementController } from './presentation/driver-settlement.controller';

/**
 * Rendición diaria del chofer (M-D, parte 2): el efectivo que cobró contra lo
 * que declara entregar. Al aprobarla, el efectivo entra a una caja por
 * `CashLedgerService` y un faltante a cargo del chofer se descuenta por
 * `CommissionLedgerService`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DriverSettlement,
      DriverSettlementOrder,
      DriverSettlementExpense,
      DriverSettlementCollection,
    ]),
    CashModule,
    AttachmentModule, // dueño `driver_settlement` de los adjuntos
    CommissionModule,
    DocumentSequenceModule,
    AdminModule, // destinatarios del aviso de rendiciones sin cerrar
    EmailModule,
    RedisModule,
  ],
  controllers: [DriverSettlementController],
  providers: [
    DriverSettlementService,
    DriverSettlementQueryService,
    DriverSettlementCron,
    DriverSettlementAttachmentOwnerResolver,
  ],
  exports: [DriverSettlementService, DriverSettlementQueryService],
})
export class DriverSettlementModule {}
