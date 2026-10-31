import { Module } from '@nestjs/common';
import { CustomersService } from './customer.service';
import { CustomersController } from './customer.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Customer } from './entities/customer.entity';
import { UsersModule } from '../users/users.module';
import { CustomerDistributor } from './entities/customer-distributor.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Customer, CustomerDistributor]),
    UsersModule,
  ],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
