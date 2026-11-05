import {
  Attachment,
  AttachmentOwnerType,
} from '../attachment/entities/attachment.entity';
import { DocumentReadingQueueService } from './document-reading-queue.service';

describe('DocumentReadingQueueService', () => {
  let service: DocumentReadingQueueService;
  let query: {
    leftJoin: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    take: jest.Mock;
    getMany: jest.Mock;
  };
  let createQueryBuilder: jest.Mock;

  beforeEach(() => {
    query = {
      leftJoin: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      addOrderBy: jest.fn(),
      take: jest.fn(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    for (const method of [
      'leftJoin',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'take',
    ] as const)
      query[method].mockReturnValue(query);
    createQueryBuilder = jest.fn().mockReturnValue(query);
    service = new DocumentReadingQueueService({
      createQueryBuilder,
    } as unknown as import('typeorm').Repository<Attachment>);
  });

  it('arma la cola aislada por distribuidora, adjuntos vivos, dueños, mime, estado, intentos, antigüedad y límite', async () => {
    await service.pendientes('d1', 9, 3, 5);
    expect(createQueryBuilder).toHaveBeenCalledWith('a');
    expect(query.leftJoin).toHaveBeenCalledWith(
      'document_reading',
      'r',
      expect.stringContaining('r.attachment_id = a.attachment_id'),
    );
    expect(query.where).toHaveBeenCalledWith(
      'a.distributor_id = :distributorId',
      { distributorId: 'd1' },
    );
    expect(query.andWhere).toHaveBeenCalledWith('a.deleted_at IS NULL');
    expect(query.andWhere).toHaveBeenCalledWith(
      'a.owner_type IN (:...owners)',
      {
        owners: [
          AttachmentOwnerType.INSURANCE_INSTALLMENT,
          AttachmentOwnerType.CASH_MOVEMENT,
        ],
      },
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      expect.stringContaining("'application/pdf'"),
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('r.attempts < :maxAttempts'),
      expect.objectContaining({ maxAttempts: 3 }),
    );
    expect(query.orderBy).toHaveBeenCalledWith('a.uploadedAt', 'ASC');
    expect(query.addOrderBy).toHaveBeenCalledWith('a.attachmentId', 'ASC');
    expect(query.take).toHaveBeenCalledWith(9);
  });

  it('con una máscara sin dueños no consulta', async () => {
    await expect(service.pendientes('d1', 1, 1, 0)).resolves.toEqual([]);
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });
});
