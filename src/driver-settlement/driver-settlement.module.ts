import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { CashModule } from '../cash/cash.module';
import { CommissionModule } from '../commission/commission.module';
import { DocumentSequenceModule } from '../document-sequence/document-sequence.module';
import { EmailModule } from '../email/email.module';
import { RedisModule } from '../redis/redis.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { EmployeeModule } from '../employee/employee.module';
import { EgresoDelChoferRule } from './application/egreso-del-chofer.rule';
import { DriverSettlementCron } from './application/driver-settlement.cron';
import { DriverCashAlertCron } from './application/driver-cash-alert.cron';
import { DistributorModule } from '../distributor/distributor.module';
import { DriverSettlementQueryService } from './application/driver-settlement-query.service';
import { AttachmentModule } from '../attachment/attachment.module';
import { DriverSettlementAttachmentOwnerResolver } from './application/driver-settlement-attachment-owner.resolver';
import { DriverSettlementService } from './application/driver-settlement.service';
import { DriverSettlementCollection } from './entities/driver-settlement-collection.entity';
import { DriverSettlementExpense } from './entities/driver-settlement-expense.entity';
import { DriverSettlementOrder } from './entities/driver-settlement-order.entity';
import { DriverSettlement } from './entities/driver-settlement.entity';
import { DriverSettlementController } from './presentation/driver-settlement.controller';
import { DriverSettlementV2Controller } from './presentation/driver-settlement-v2.controller';

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
    DeliveryModule, // el perfil de chofer del legajo
    EmployeeModule, // regla de egreso del chofer (CU-181)
    DistributorModule, // parámetros del aviso de efectivo sin rendir (`cash_alerts`)
  ],
  controllers: [DriverSettlementController, DriverSettlementV2Controller],
  providers: [
    DriverSettlementService,
    DriverSettlementQueryService,
    DriverSettlementCron,
    DriverCashAlertCron,
    DriverSettlementAttachmentOwnerResolver,
    EgresoDelChoferRule,
  ],
  exports: [DriverSettlementService, DriverSettlementQueryService],
})
export class DriverSettlementModule {}
