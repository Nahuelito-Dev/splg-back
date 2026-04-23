// src/gascylinder/gascylinder.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GasCylinderController } from './gascylinder.controller';
import { GasCylinderService } from './gascylinder.service';
import { GasCylinder } from './entities/gascylinder.entity';

@Module({
  imports: [TypeOrmModule.forFeature([GasCylinder])],
  controllers: [GasCylinderController],
  providers: [GasCylinderService],
  exports: [GasCylinderService, TypeOrmModule.forFeature([GasCylinder])], // ← AGREGAR ESTO
})
export class GasCylinderModule {}
