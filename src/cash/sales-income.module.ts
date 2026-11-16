import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { CashCollectionSettingsService } from './application/cash-collection-settings.service';
import { CashModule } from './cash.module';
import { CashCollectionSettingsController } from './presentation/cash-collection-settings.controller';

/**
 * Cajas de cobro de las ventas y asiento de los cobros pendientes (API v2).
 * Vive aparte de `CashModule` porque para completar lo que falta (comisión y
 * monto de pagos anteriores) le pregunta a la pasarela, y `payments` ya depende
 * de `cash`: un módulo que importa a los dos evita el ciclo.
 */
@Module({
  imports: [CashModule, PaymentsModule],
  controllers: [CashCollectionSettingsController],
  providers: [CashCollectionSettingsService],
})
export class SalesIncomeModule {}
