import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IncidentService } from './incident.service';
import { IncidentController } from './incident.controller';
import { Incident } from './entities/incident.entity';
import { IncidentPhotoService } from './incident-photo.service';
import { OrderModule } from '../order/order.module';
import { S3Module } from '../s3/s3.module';

@Module({
  // OrderService: la incidencia hereda la distribuidora del pedido.
  imports: [TypeOrmModule.forFeature([Incident]), OrderModule, S3Module],
  controllers: [IncidentController],
  providers: [IncidentService, IncidentPhotoService],
  exports: [IncidentService],
})
export class IncidentModule {}
