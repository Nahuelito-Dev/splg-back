import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { User } from './entities/user.entity';
import { UserPhotoService } from './user-photo.service';
import { S3Module } from '../s3/s3.module';
import { OrderLookupModule } from '../order/lookup/order-lookup.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    ConfigModule,
    OrderLookupModule,
    // La foto de perfil vive en S3.
    S3Module,
  ],
  controllers: [UsersController],
  providers: [UsersService, UserPhotoService],
  exports: [UsersService, UserPhotoService],
})
export class UsersModule {}
