import { Module } from '@nestjs/common';
import { CustomersService } from './customer.service';
import { CustomersController } from './customer.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Customer } from './entities/customer.entity';
import { RepurchaseInvitation } from './entities/repurchase-invitation.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Customer, RepurchaseInvitation])],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
