// delivery/delivery.module.ts
import { Module } from '@nestjs/common';
import { DeliveryService } from './delivery.service';
import { DeliveryController } from './delivery.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from 'src/users/entities/user.entity';
import { Delivery } from './entities/delivery.entity';
import { Role } from '../role/entities/role.entity';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Delivery, User, Role]),
    // FirebaseModule es @Global, FirebaseAuthPort ya está disponible sin importarlo.
    // NO se importa UsersModule: DeliveryService habla con el repo de User
    // directamente (P2-3), evitando el ciclo users↔delivery.
    RedisModule,
  ],
  controllers: [DeliveryController],
  providers: [DeliveryService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
