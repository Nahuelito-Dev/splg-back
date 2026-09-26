import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IncidentService } from './incident.service';
import { IncidentController } from './incident.controller';
import { Incident } from './entities/incident.entity';
import { OrderModule } from '../order/order.module';

@Module({
  // OrderService: la incidencia hereda la distribuidora del pedido.
  imports: [TypeOrmModule.forFeature([Incident]), OrderModule],
  controllers: [IncidentController],
  providers: [IncidentService],
  exports: [IncidentService],
})
export class IncidentModule {}
