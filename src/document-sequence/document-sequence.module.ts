import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentSequence } from './entities/document-sequence.entity';
import { DocumentSequenceService } from './document-sequence.service';

/**
 * Numeración correlativa de comprobantes por distribuidora. Sin endpoints: la
 * usan los módulos que emiten documentos, dentro de su transacción.
 */
@Module({
  imports: [TypeOrmModule.forFeature([DocumentSequence])],
  providers: [DocumentSequenceService],
  exports: [DocumentSequenceService],
})
export class DocumentSequenceModule {}
