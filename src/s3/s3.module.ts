import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { S3Service } from './s3.service';
import { S3CleanupService } from './s3-cleanup.service';
import { StorageOrphan } from './entities/storage-orphan.entity';

/**
 * Archivos de la app: Amazon S3 es el único proveedor (en desarrollo, MinIO
 * como S3 compatible). `S3Service` habla con el bucket; `S3CleanupService`
 * borra en segundo plano, con reintentos y registro de huérfanos.
 */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([StorageOrphan])],
  providers: [S3Service, S3CleanupService],
  exports: [S3Service, S3CleanupService],
})
export class S3Module {}
