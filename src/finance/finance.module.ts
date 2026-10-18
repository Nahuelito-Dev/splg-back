import { Module } from '@nestjs/common';
import { CashModule } from '../cash/cash.module';
import { CommissionModule } from '../commission/commission.module';
import { CustomerAccountModule } from '../customer-account/customer-account.module';
import { DriverSettlementModule } from '../driver-settlement/driver-settlement.module';
import { RedisModule } from '../redis/redis.module';
import { FinanceReconciliationCron } from './application/finance-reconciliation.cron';
import { FinanceService } from './application/finance.service';
import { FinanceController } from './presentation/finance.controller';

/**
 * Finanzas (M-D, parte 5): el tablero financiero y la conciliación nocturna.
 * No tiene entidades propias: lee lo que exportan caja, rendiciones, cuentas
 * corrientes y comisiones.
 */
@Module({
  imports: [
    CashModule,
    CommissionModule,
    CustomerAccountModule,
    DriverSettlementModule,
    RedisModule,
  ],
  controllers: [FinanceController],
  providers: [FinanceService, FinanceReconciliationCron],
})
export class FinanceModule {}
