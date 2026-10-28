import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CashBoxService } from './application/cash-box.service';
import { CashCategoryService } from './application/cash-category.service';
import { CashDocumentPaymentService } from './application/cash-document-payment.service';
import { AttachmentModule } from '../attachment/attachment.module';
import { CashMovementAttachmentOwnerResolver } from './application/cash-movement-attachment-owner.resolver';
import { CashLedgerService } from './application/cash-ledger.service';
import { CashMovementService } from './application/cash-movement.service';
import { CashSeedListener } from './application/cash-seed.listener';
import { CashSessionService } from './application/cash-session.service';
import { CashBox } from './entities/cash-box.entity';
import { CashCategory } from './entities/cash-category.entity';
import { CashMovement } from './entities/cash-movement.entity';
import { CashSession } from './entities/cash-session.entity';
import { CashBoxController } from './presentation/cash-box.controller';
import { CashCategoryController } from './presentation/cash-category.controller';
import { CashMovementController } from './presentation/cash-movement.controller';
import { CashSessionController } from './presentation/cash-session.controller';

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
    ]),
    AttachmentModule, // dueño `cash_movement` de los adjuntos
  ],
  controllers: [
    CashBoxController,
    CashSessionController,
    CashMovementController,
    CashCategoryController,
  ],
  providers: [
    CashLedgerService,
    CashDocumentPaymentService,
    CashBoxService,
    CashSessionService,
    CashMovementService,
    CashCategoryService,
    CashSeedListener,
    CashMovementAttachmentOwnerResolver,
  ],
  exports: [
    CashLedgerService,
    CashDocumentPaymentService,
    CashCategoryService,
    CashBoxService,
    CashMovementService,
    CashSessionService,
  ],
})
export class CashModule {}
