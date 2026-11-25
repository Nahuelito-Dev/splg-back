import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportsController } from './reports.controller';
import { ReportsV2Controller } from './reports-v2.controller';
import { ReportsV3Controller } from './reports-v3.controller';
import { ReportsService } from './reports.service';
import { ReportsResolver } from './reports.resolver';
import { Order } from '../order/entities/order.entity';
import { OrderItem } from '../order/entities/order-item.entity';
import { S3Module } from '../s3/s3.module';
import { FleetExpenseModule } from '../fleet-expense/fleet-expense.module';

@Module({
  // Modelo de lectura: consulta pedidos de otro contexto sólo para agregarlos
  // (ver CONVENCIONES, excepción a la regla de encapsulamiento). No escribe.
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem]),
    S3Module,
    FleetExpenseModule,
  ],
  controllers: [ReportsController, ReportsV2Controller, ReportsV3Controller],
  providers: [ReportsService, ReportsResolver],
  exports: [ReportsService],
})
export class ReportsModule {}
