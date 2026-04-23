// src/user-addres/user-addres.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserAddresController } from './user-addres.controller';
import { UserAddresService } from './user-addres.service';
import { UserAddress } from './entities/user-addres.entity';
import { User } from '../users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([UserAddress, User])],
  controllers: [UserAddresController],
  providers: [UserAddresService],
  exports: [UserAddresService],
})
export class UserAddresModule {}
