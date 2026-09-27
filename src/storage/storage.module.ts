import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StoragePort } from './ports/storage.port';
import { LocalDiskStorageAdapter } from './infrastructure/local-disk-storage.adapter';
import { S3StorageAdapter } from './infrastructure/s3-storage.adapter';

/**
 * Módulo de almacenamiento de archivos. Expone `StoragePort`: quien lo
 * inyecta no sabe si detrás hay disco local o S3, sólo `STORAGE_DRIVER` lo
 * decide (ver `ports/storage.port.ts`).
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: StoragePort,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StoragePort => {
        const driver = config.get<string>('STORAGE_DRIVER', 'local');
        return driver === 's3'
          ? new S3StorageAdapter(config)
          : new LocalDiskStorageAdapter(config);
      },
    },
  ],
  exports: [StoragePort],
})
export class StorageModule {}
