import { NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import type { MpReconciliation } from '../entities/mp-reconciliation.entity';
import { MpReconciliationAttachmentOwnerResolver } from './mp-reconciliation-attachment-owner.resolver';

describe('MpReconciliationAttachmentOwnerResolver', () => {
  let existe: boolean;
  let registry: AttachmentOwnerRegistry;
  let resolver: MpReconciliationAttachmentOwnerResolver;
  const exists = jest.fn(() => Promise.resolve(existe));

  beforeEach(() => {
    existe = true;
    registry = new AttachmentOwnerRegistry();
    resolver = new MpReconciliationAttachmentOwnerResolver(
      { exists } as unknown as Repository<MpReconciliation>,
      registry,
    );
  });

  it('se registra como dueño mp_reconciliation', () => {
    resolver.onModuleInit();

    expect(registry.find(AttachmentOwnerType.MP_RECONCILIATION)).toBe(resolver);
  });

  it('acepta una corrida de la distribuidora y rechaza (404) la de otra', async () => {
    await expect(
      resolver.assertOwner('rec-1', 'dist-1'),
    ).resolves.toBeUndefined();
    expect(exists).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { reconciliationId: 'rec-1', distributorId: 'dist-1' },
      }),
    );

    existe = false;
    await expect(
      resolver.assertOwner('rec-1', 'dist-2'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
