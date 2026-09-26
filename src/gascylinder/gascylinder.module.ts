// src/gascylinder/gascylinder.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GasCylinderController } from './gascylinder.controller';
import { GasCylinderService } from './gascylinder.service';
import { GasCylinder } from './entities/gascylinder.entity';
import { GasCylinderPromotion } from './entities/gascylinder-promotion.entity';

@Module({
  imports: [TypeOrmModule.forFeature([GasCylinder, GasCylinderPromotion])],
  controllers: [GasCylinderController],
  providers: [GasCylinderService],
  exports: [GasCylinderService],
})
export class GasCylinderModule {}
