import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CylinderService } from './cylinder.service';
import { CylinderController } from './cylinder.controller';
import { Cylinder } from './entities/cylinder.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import { Order } from '../order/entities/order.entity';
import { CylinderInspection } from './entities/cylinder-inspection.entity';
import { CylinderRecoveryCase } from './entities/cylinder-recovery-case.entity';
import { CylinderRecoveryNotice } from './entities/cylinder-recovery-notice.entity';

@Module({
  // Order: el envase toma el cliente del pedido. order ya depende de cylinder
  // (al entregar avanza los envases); cortar esta lectura va con order en la
  // tanda 3 (ver DONDE-QUEDAMOS).
  imports: [
    TypeOrmModule.forFeature([
      Cylinder,
      CylinderMovement,
      CylinderInspection,
      CylinderRecoveryCase,
      CylinderRecoveryNotice,
      Order,
    ]),
  ],
  controllers: [CylinderController],
  providers: [CylinderService],
  exports: [CylinderService],
})
export class CylinderModule {}
