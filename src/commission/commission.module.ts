import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CashModule } from '../cash/cash.module';
import { DocumentSequenceModule } from '../document-sequence/document-sequence.module';
import { CommissionLedgerService } from './application/commission-ledger.service';
import { CommissionListener } from './application/commission.listener';
import { CommissionQueryService } from './application/commission-query.service';
import { CommissionRuleService } from './application/commission-rule.service';
import { DriverLiquidationService } from './application/driver-liquidation.service';
import { CommissionEntry } from './entities/commission-entry.entity';
import { CommissionRule } from './entities/commission-rule.entity';
import { DriverLiquidation } from './entities/driver-liquidation.entity';
import { CommissionRuleController } from './presentation/commission-rule.controller';
import { CommissionController } from './presentation/commission.controller';
import { DriverLiquidationController } from './presentation/driver-liquidation.controller';

/**
 * Comisiones por entrega (M-D, parte 4): reglas, libro de asientos del chofer y
 * liquidaciones. La comisión se devenga al escuchar `pedido.entregado`; el pago
 * de una liquidación sale de una caja por `CashLedgerService`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CommissionRule,
      CommissionEntry,
      DriverLiquidation,
    ]),
    CashModule, // egreso del pago de la liquidación
    DocumentSequenceModule, // número de la liquidación
  ],
  controllers: [
    CommissionRuleController,
    CommissionController,
    DriverLiquidationController,
  ],
  providers: [
    CommissionRuleService,
    CommissionLedgerService,
    CommissionQueryService,
    DriverLiquidationService,
    CommissionListener,
  ],
  exports: [
    CommissionLedgerService,
    CommissionQueryService,
    DriverLiquidationService,
  ],
})
export class CommissionModule {}
