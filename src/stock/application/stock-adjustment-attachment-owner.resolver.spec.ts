import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { StockAdjustment } from '../entities/stock-adjustment.entity';
import { StockAdjustmentAttachmentOwnerResolver } from './stock-adjustment-attachment-owner.resolver';

describe('StockAdjustmentAttachmentOwnerResolver', () => {
  let exists: jest.Mock;
  let registry: AttachmentOwnerRegistry;
  let resolver: StockAdjustmentAttachmentOwnerResolver;

  beforeEach(() => {
    exists = jest.fn();
    registry = new AttachmentOwnerRegistry();
    resolver = new StockAdjustmentAttachmentOwnerResolver(
      { exists } as unknown as Repository<StockAdjustment>,
      registry,
    );
  });

  it('se registra como dueño stock_adjustment al iniciar el módulo', () => {
    resolver.onModuleInit();
    expect(registry.find(AttachmentOwnerType.STOCK_ADJUSTMENT)).toBe(resolver);
  });

  it('el ajuste de la distribuidora existe: no lanza, y la consulta lleva el tenant', async () => {
    exists.mockResolvedValue(true);
    await expect(resolver.assertOwner('a1', 'd1')).resolves.toBeUndefined();
    expect(exists).toHaveBeenCalledWith({
      where: { adjustmentId: 'a1', distributorId: 'd1' },
    });
  });

  it('un ajuste inexistente o de otra distribuidora es 404', async () => {
    exists.mockResolvedValue(false);
    await expect(resolver.assertOwner('a1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('no implementa isOwnedByUser: el chofer no accede', () => {
    expect('isOwnedByUser' in resolver).toBe(false);
  });
});
