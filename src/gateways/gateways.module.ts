import { Module } from '@nestjs/common';
import { DriversGateway } from './drivers.gateway';
import { CustomersGateway } from './customers.gateway';

import { RedisModule } from '../redis/redis.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [RedisModule, AuthModule],
  providers: [DriversGateway, CustomersGateway],
  exports: [DriversGateway, CustomersGateway],
})
export class GatewaysModule { }
