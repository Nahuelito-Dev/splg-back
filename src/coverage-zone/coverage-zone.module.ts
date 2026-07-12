import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CoverageZoneService } from './coverage-zone.service';
import { CoverageZoneController } from './coverage-zone.controller';
import { CoverageZone } from './entities/coverage-zone.entity';

@Module({
  imports: [TypeOrmModule.forFeature([CoverageZone])],
  controllers: [CoverageZoneController],
  providers: [CoverageZoneService],
  exports: [CoverageZoneService],
})
export class CoverageZoneModule {}
