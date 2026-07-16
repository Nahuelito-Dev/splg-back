// src/users/users.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from './entities/user.entity';
import { AuthModule } from '../auth/auth.module';
import { CustomersModule } from '../customer/customer.module';
import { DeliveryModule } from '../delivery/delivery.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    ConfigModule,
    forwardRef(() => AuthModule),
    // CustomersModule importa EmailModule, que a su vez importa este mismo
    // módulo (forwardRef) → sin forwardRef acá el ciclo Users→Customer→Email→Users
    // rompería según el orden de carga (P2-3).
    forwardRef(() => CustomersModule),
    // DeliveryModule NO depende de UsersModule ni de EmailModule, así que este
    // borde no es circular y no necesita forwardRef.
    DeliveryModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
