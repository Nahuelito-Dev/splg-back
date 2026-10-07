import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Attachment } from './entities/attachment.entity';
import { S3Module } from '../s3/s3.module';
import { AttachmentController } from './attachment.controller';
import { AttachmentService } from './attachment.service';
import { AttachmentOwnerRegistry } from './attachment-owner.registry';

/**
 * Adjuntos genéricos de los módulos de empresa. No importa ningún módulo de
 * negocio: cada dueño importa este módulo y registra su
 * `AttachmentOwnerResolver` en `AttachmentOwnerRegistry`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Attachment]), S3Module],
  controllers: [AttachmentController],
  providers: [AttachmentService, AttachmentOwnerRegistry],
  exports: [AttachmentOwnerRegistry],
})
export class AttachmentModule {}
