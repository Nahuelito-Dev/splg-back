import { Module } from '@nestjs/common';
import { ClaimsService } from './claims.service';
import { ClaimsController } from './claims.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Claim } from './entities/claim.entity';
import { OrderModule } from '../order/order.module';
import { S3Module } from '../s3/s3.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Claim]),
    // OrderService valida que el pedido reclamado exista y sea del cliente.
    OrderModule,
    // La foto del reclamo vive en S3.
    S3Module,
  ],
  controllers: [ClaimsController],
  providers: [ClaimsService],
})
export class ClaimsModule {}
