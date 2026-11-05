import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Attachment } from '../attachment/entities/attachment.entity';
import { S3Module } from '../s3/s3.module';

import { DocumentReadingController } from './document-reading.controller';
import { DocumentReadingService } from './document-reading.service';
import { DocumentReading } from './entities/document-reading.entity';
import { DocumentReadingSettingsService } from './document-reading-settings.service';
import { DocumentReadingQueueService } from './document-reading-queue.service';
import { DocumentReadingRunnerService } from './document-reading-runner.service';
import { DocumentReadingCron } from './document-reading.cron';

/**
 * Lecturas de documentos del módulo M6 (lo que se extrajo de cada adjunto).
 * Global: el escaneo de comprobantes y el proceso automático las usan.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([DocumentReading, Attachment]), S3Module],
  controllers: [DocumentReadingController],
  providers: [
    DocumentReadingService,
    DocumentReadingSettingsService,
    DocumentReadingQueueService,
    DocumentReadingRunnerService,
    DocumentReadingCron,
  ],
  exports: [DocumentReadingService, DocumentReadingRunnerService],
})
export class DocumentReadingModule {}
