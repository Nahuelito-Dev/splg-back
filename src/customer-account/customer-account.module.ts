import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CashModule } from '../cash/cash.module';
import { DriverSettlementModule } from '../driver-settlement/driver-settlement.module';
import { CustomerAccountQueryService } from './application/customer-account-query.service';
import { CustomerAccountService } from './application/customer-account.service';
import { CustomerChargeListener } from './application/customer-charge.listener';
import { CustomerLedgerService } from './application/customer-ledger.service';
import { CustomerAccountAllocation } from './entities/customer-account-allocation.entity';
import { CustomerAccountEntry } from './entities/customer-account-entry.entity';
import { CustomerAccount } from './entities/customer-account.entity';
import { CustomerAccountController } from './presentation/customer-account.controller';

/**
 * Cuentas corrientes de clientes (M-D, parte 3): habilitación, libro de
 * asientos (cargos, pagos, ajustes) con imputación FIFO, estado de cuenta,
 * antigüedad de la deuda y control de crédito de la venta a cuenta.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CustomerAccount,
      CustomerAccountEntry,
      CustomerAccountAllocation,
    ]),
    CashModule, // entrada a caja del pago del administrador
    DriverSettlementModule, // el cobro del chofer en la calle entra por su rendición
  ],
  controllers: [CustomerAccountController],
  providers: [
    CustomerAccountService,
    CustomerAccountQueryService,
    CustomerLedgerService,
    CustomerChargeListener,
  ],
  exports: [
    CustomerAccountService,
    CustomerLedgerService,
    CustomerAccountQueryService,
  ],
})
export class CustomerAccountModule {}
