import { Module } from '@nestjs/common';
import { DriversGateway } from './drivers.gateway';
import { CustomersGateway } from './customers.gateway';
import { AdminGateway } from './admin.gateway';

import { RedisModule } from '../redis/redis.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [RedisModule, AuthModule],
  providers: [DriversGateway, CustomersGateway, AdminGateway],
  exports: [DriversGateway, CustomersGateway, AdminGateway],
})
export class GatewaysModule { }
