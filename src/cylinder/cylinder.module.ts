import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CylinderService } from './cylinder.service';
import { CylinderController } from './cylinder.controller';
import { Cylinder } from './entities/cylinder.entity';
import { CylinderMovement } from './entities/cylinder-movement.entity';
import { Order } from '../order/entities/order.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Cylinder, CylinderMovement, Order])],
  controllers: [CylinderController],
  providers: [CylinderService],
  exports: [CylinderService],
})
export class CylinderModule {}
