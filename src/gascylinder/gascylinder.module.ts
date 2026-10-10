// src/gascylinder/gascylinder.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GasCylinderController } from './gascylinder.controller';
import { GasCylinderService } from './gascylinder.service';
import { GasCylinder } from './entities/gascylinder.entity';
import { GasCylinderPromotion } from './entities/gascylinder-promotion.entity';
import { GasCylinderPhotoService } from './gascylinder-photo.service';
import { S3Module } from '../s3/s3.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([GasCylinder, GasCylinderPromotion]),
    S3Module, // imagen del producto
  ],
  controllers: [GasCylinderController],
  providers: [GasCylinderService, GasCylinderPhotoService],
  exports: [GasCylinderService],
})
export class GasCylinderModule {}
