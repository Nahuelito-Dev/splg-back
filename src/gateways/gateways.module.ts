import { Module } from '@nestjs/common';
import { DriversGateway } from './drivers.gateway';
import { CustomersGateway } from './customers.gateway';
import { AdminGateway } from './admin.gateway';
import { SocketIdentityService } from './socket-identity.service';
import { RedisModule } from '../redis/redis.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [RedisModule, AuthModule, UsersModule],
  providers: [
    SocketIdentityService,
    DriversGateway,
    CustomersGateway,
    AdminGateway,
  ],
  exports: [DriversGateway, CustomersGateway, AdminGateway],
})
export class GatewaysModule {}
