import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CoverageZoneService } from './coverage-zone.service';
import { CoverageZonePricingService } from './coverage-zone-pricing.service';
import { CoverageZoneController } from './coverage-zone.controller';
import { CoverageZone } from './entities/coverage-zone.entity';
import { GatewaysModule } from '../gateways/gateways.module';
import { CoverageZoneExpiryCron } from './coverage-zone-expiry.cron';

@Module({
  imports: [TypeOrmModule.forFeature([CoverageZone]), GatewaysModule],
  controllers: [CoverageZoneController],
  providers: [
    CoverageZoneService,
    CoverageZonePricingService,
    CoverageZoneExpiryCron,
  ],
  exports: [CoverageZoneService, CoverageZonePricingService],
})
export class CoverageZoneModule {}
