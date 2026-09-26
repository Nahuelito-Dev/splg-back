import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CoverageZoneService } from './coverage-zone.service';
import { CoverageZonePricingService } from './coverage-zone-pricing.service';
import { CoverageZoneController } from './coverage-zone.controller';
import { CoverageZone } from './entities/coverage-zone.entity';

@Module({
  imports: [TypeOrmModule.forFeature([CoverageZone])],
  controllers: [CoverageZoneController],
  providers: [CoverageZoneService, CoverageZonePricingService],
  exports: [CoverageZoneService, CoverageZonePricingService],
})
export class CoverageZoneModule {}
