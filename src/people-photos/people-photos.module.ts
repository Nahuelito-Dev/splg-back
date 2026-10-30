import { Module } from '@nestjs/common';
import { S3Module } from '../s3/s3.module';
import { PeoplePhotosController } from './people-photos.controller';
import { PeoplePhotosService } from './people-photos.service';

/** Modelo de lectura: firma fotos de usuarios y legajos; no tiene datos propios. */
@Module({
  imports: [S3Module],
  controllers: [PeoplePhotosController],
  providers: [PeoplePhotosService],
})
export class PeoplePhotosModule {}
