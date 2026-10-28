import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { Order } from '../order/entities/order.entity';
import { OrderItem } from '../order/entities/order-item.entity';

@Module({
  // Modelo de lectura: consulta pedidos de otro contexto sólo para agregarlos
  // (ver CONVENCIONES, excepción a la regla de encapsulamiento). No escribe.
  imports: [TypeOrmModule.forFeature([Order, OrderItem])],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
