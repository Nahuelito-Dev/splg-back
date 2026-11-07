import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomersModule } from '../customer/customer.module';
import { CustomerContainerController } from './customer-container.controller';
import { CustomerContainerService } from './customer-container.service';
import { CustomerContainerAccount } from './entities/customer-container-account.entity';
import { CustomerContainerMovement } from './entities/customer-container-movement.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CustomerContainerAccount,
      CustomerContainerMovement,
    ]),
    CustomersModule,
  ],
  controllers: [CustomerContainerController],
  providers: [CustomerContainerService],
  exports: [CustomerContainerService],
})
export class CustomerContainerModule {}
