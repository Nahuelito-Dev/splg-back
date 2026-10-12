import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { PurchaseReceipt } from '../entities/purchase-receipt.entity';
import { PurchaseReceiptAttachmentOwnerResolver } from './purchase-receipt-attachment-owner.resolver';

describe('PurchaseReceiptAttachmentOwnerResolver', () => {
  let exists: jest.Mock;
  let registry: AttachmentOwnerRegistry;
  let resolver: PurchaseReceiptAttachmentOwnerResolver;

  beforeEach(() => {
    exists = jest.fn();
    registry = new AttachmentOwnerRegistry();
    resolver = new PurchaseReceiptAttachmentOwnerResolver(
      { exists } as unknown as Repository<PurchaseReceipt>,
      registry,
    );
  });

  it('se registra como dueño purchase_receipt al iniciar el módulo', () => {
    resolver.onModuleInit();
    expect(registry.find(AttachmentOwnerType.PURCHASE_RECEIPT)).toBe(resolver);
  });

  it('el recepción de la distribuidora existe: no lanza, y la consulta lleva el tenant', async () => {
    exists.mockResolvedValue(true);
    await expect(resolver.assertOwner('a1', 'd1')).resolves.toBeUndefined();
    expect(exists).toHaveBeenCalledWith({
      where: { receiptId: 'a1', distributorId: 'd1' },
    });
  });

  it('un recepción inexistente o de otra distribuidora es 404', async () => {
    exists.mockResolvedValue(false);
    await expect(resolver.assertOwner('a1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('no implementa isOwnedByUser: el chofer no accede', () => {
    expect('isOwnedByUser' in resolver).toBe(false);
  });
});
