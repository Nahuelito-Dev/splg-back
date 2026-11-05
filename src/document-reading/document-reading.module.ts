import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DocumentReadingController } from './document-reading.controller';
import { DocumentReadingService } from './document-reading.service';
import { DocumentReading } from './entities/document-reading.entity';

/**
 * Lecturas de documentos del módulo M6 (lo que se extrajo de cada adjunto).
 * Global: el escaneo de comprobantes y el proceso automático las usan.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([DocumentReading])],
  controllers: [DocumentReadingController],
  providers: [DocumentReadingService],
  exports: [DocumentReadingService],
})
export class DocumentReadingModule {}
