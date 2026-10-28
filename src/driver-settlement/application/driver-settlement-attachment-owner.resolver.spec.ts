import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { DriverSettlement } from '../entities/driver-settlement.entity';
import { DriverSettlementAttachmentOwnerResolver } from './driver-settlement-attachment-owner.resolver';

describe('DriverSettlementAttachmentOwnerResolver', () => {
  let exists: jest.Mock;
  let registry: AttachmentOwnerRegistry;
  let resolver: DriverSettlementAttachmentOwnerResolver;

  beforeEach(() => {
    exists = jest.fn();
    registry = new AttachmentOwnerRegistry();
    resolver = new DriverSettlementAttachmentOwnerResolver(
      { exists } as unknown as Repository<DriverSettlement>,
      registry,
    );
  });

  it('se registra como dueño driver_settlement al iniciar el módulo', () => {
    resolver.onModuleInit();
    expect(registry.find(AttachmentOwnerType.DRIVER_SETTLEMENT)).toBe(resolver);
  });

  it('el dueño de la distribuidora existe: no lanza, y la consulta lleva el tenant', async () => {
    exists.mockResolvedValue(true);
    await expect(resolver.assertOwner('a1', 'd1')).resolves.toBeUndefined();
    expect(exists).toHaveBeenCalledWith({
      where: { settlementId: 'a1', distributorId: 'd1' },
    });
  });

  it('inexistente o de otra distribuidora es 404', async () => {
    exists.mockResolvedValue(false);
    await expect(resolver.assertOwner('a1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('es propia si la rendición es del chofer y de la distribuidora', async () => {
    exists.mockResolvedValue(true);
    await expect(resolver.isOwnedByUser('s1', 'u1', 'd1')).resolves.toBe(true);
    expect(exists).toHaveBeenCalledWith({
      where: {
        settlementId: 's1',
        distributorId: 'd1',
        delivery: { userId: 'u1' },
      },
    });
  });

  it('no es propia si es de otro chofer', async () => {
    exists.mockResolvedValue(false);
    await expect(resolver.isOwnedByUser('s1', 'u2', 'd1')).resolves.toBe(false);
  });
});
