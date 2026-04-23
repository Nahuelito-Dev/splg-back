import { Module } from '@nestjs/common';
import { ClaimsService } from './claims.service';
import { ClaimsController } from './claims.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Claim } from './entities/claim.entity';
import { OrderModule } from '../order/order.module'; // Para usar OrderService

@Module({
  imports: [
    TypeOrmModule.forFeature([Claim]),
    OrderModule, // 👈 Importante para validar órdenes
  ],
  controllers: [ClaimsController],
  providers: [ClaimsService],
})
export class ClaimsModule {}
