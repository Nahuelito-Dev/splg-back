import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Attachment } from '../attachment/entities/attachment.entity';
import { DocumentReadingStatus } from './entities/document-reading.entity';
import { ownersForMask } from './document-reading-owners';

@Injectable()
export class DocumentReadingQueueService {
  constructor(
    @InjectRepository(Attachment)
    private readonly attachments: Repository<Attachment>,
  ) {}
  pendientes(
    distributorId: string,
    limite: number,
    maxAttempts: number,
    typesMask = 255,
  ): Promise<Attachment[]> {
    const owners = ownersForMask(typesMask).map((o) => o.ownerType);
    if (owners.length === 0) return Promise.resolve([]);
    return this.attachments
      .createQueryBuilder('a')
      .leftJoin(
        'document_reading',
        'r',
        'r.attachment_id = a.attachment_id AND r.deleted_at IS NULL',
      )
      .where('a.distributor_id = :distributorId', { distributorId })
      .andWhere('a.deleted_at IS NULL')
      .andWhere('a.owner_type IN (:...owners)', { owners })
      .andWhere(
        "a.mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')",
      )
      .andWhere(
        '(r.reading_id IS NULL OR r.status = :pending OR (r.status = :failed AND r.attempts < :maxAttempts))',
        {
          pending: DocumentReadingStatus.PENDING,
          failed: DocumentReadingStatus.FAILED,
          maxAttempts,
        },
      )
      .orderBy('a.uploadedAt', 'ASC')
      .addOrderBy('a.attachmentId', 'ASC')
      .take(limite)
      .getMany();
  }
}
