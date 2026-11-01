import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CashBoxService } from './application/cash-box.service';
import { CashCategoryService } from './application/cash-category.service';
import { CashDocumentPaymentService } from './application/cash-document-payment.service';
import { AttachmentModule } from '../attachment/attachment.module';
import { CashMovementAttachmentOwnerResolver } from './application/cash-movement-attachment-owner.resolver';
import { SalesCashService } from './application/sales-cash.service';
import { CashLedgerService } from './application/cash-ledger.service';
import { CashIncomeStatementService } from './application/cash-income-statement.service';
import { CashMovementService } from './application/cash-movement.service';
import { CashSeedListener } from './application/cash-seed.listener';
import { CashSessionService } from './application/cash-session.service';
import { CashBox } from './entities/cash-box.entity';
import { CashCollectionSettings } from './entities/cash-collection-settings.entity';
import { CashCategory } from './entities/cash-category.entity';
import { CashMovement } from './entities/cash-movement.entity';
import { CashSession } from './entities/cash-session.entity';
import { CashBoxController } from './presentation/cash-box.controller';
import { CashCategoryController } from './presentation/cash-category.controller';
import { CashMovementV2Controller } from './presentation/cash-movement-v2.controller';
import { CashMovementController } from './presentation/cash-movement.controller';
import { CashSessionController } from './presentation/cash-session.controller';
import { CashSessionV2Controller } from './presentation/cash-session-v2.controller';

/**
 * Caja (M-D, parte 1): cajas, sesiones con arqueo, categorías y el libro de
 * movimientos. `CashLedgerService` es el ÚNICO que mueve dinero; lo exportan
 * las rendiciones, las cuentas corrientes y las liquidaciones de comisiones.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CashBox,
      CashSession,
      CashCategory,
      CashMovement,
      CashCollectionSettings,
    ]),
    AttachmentModule, // dueño `cash_movement` de los adjuntos
  ],
  controllers: [
    CashBoxController,
    CashSessionController,
    CashSessionV2Controller,
    CashMovementController,
    CashMovementV2Controller,
    CashCategoryController,
  ],
  providers: [
    CashLedgerService,
    CashDocumentPaymentService,
    CashBoxService,
    CashSessionService,
    CashMovementService,
    CashIncomeStatementService,
    CashCategoryService,
    SalesCashService,
    CashSeedListener,
    CashMovementAttachmentOwnerResolver,
  ],
  exports: [
    CashLedgerService,
    CashDocumentPaymentService,
    CashCategoryService,
    CashBoxService,
    CashMovementService,
    CashIncomeStatementService,
    CashSessionService,
    SalesCashService,
  ],
})
export class CashModule {}
