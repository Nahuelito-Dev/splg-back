import { Module } from '@nestjs/common';
import { CustomersService } from './customer.service';
import { CustomersController } from './customer.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from 'src/users/entities/user.entity';
import { Role } from 'src/role/entities/role.entity';
import { Customer } from './entities/customer.entity';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Customer, User, Role]),
    // FirebaseModule es @Global, FirebaseAuthPort ya está disponible sin importarlo.
    // NO se importa UsersModule: CustomersService habla con el repo de User
    // directamente (P2-3), evitando el ciclo users↔customer.
    EmailModule,
  ],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
