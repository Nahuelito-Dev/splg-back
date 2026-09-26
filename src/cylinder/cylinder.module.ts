import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CylinderService } from './cylinder.service';
import { CylinderController } from './cylinder.controller';
import { Cylinder } from './entities/cylinder.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import { OrderLookupModule } from '../order/lookup/order-lookup.module';
import { CylinderInspection } from './entities/cylinder-inspection.entity';
import { CylinderRecoveryCase } from './entities/cylinder-recovery-case.entity';
import { CylinderRecoveryNotice } from './entities/cylinder-recovery-notice.entity';

@Module({
  // El envase toma el cliente del pedido. Se lee por OrderLookupModule y no
  // por OrderModule, que importa a cylinder para avanzar los envases al entregar.
  imports: [
    TypeOrmModule.forFeature([
      Cylinder,
      CylinderMovement,
      CylinderInspection,
      CylinderRecoveryCase,
      CylinderRecoveryNotice,
    ]),
    OrderLookupModule,
  ],
  controllers: [CylinderController],
  providers: [CylinderService],
  exports: [CylinderService],
})
export class CylinderModule {}
