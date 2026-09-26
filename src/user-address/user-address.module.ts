import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserAddressController } from './user-address.controller';
import { UserAddressService } from './user-address.service';
import { UserAddress } from './entities/user-address.entity';
import { UsersModule } from '../users/users.module';

@Module({
  // UsersService: la dirección se da de alta para un usuario que tiene que existir.
  imports: [TypeOrmModule.forFeature([UserAddress]), UsersModule],
  controllers: [UserAddressController],
  providers: [UserAddressService],
  exports: [UserAddressService],
})
export class UserAddressModule {}
