import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { CashMovement } from '../entities/cash-movement.entity';
import { CashMovementAttachmentOwnerResolver } from './cash-movement-attachment-owner.resolver';

describe('CashMovementAttachmentOwnerResolver', () => {
  let exists: jest.Mock;
  let registry: AttachmentOwnerRegistry;
  let resolver: CashMovementAttachmentOwnerResolver;

  beforeEach(() => {
    exists = jest.fn();
    registry = new AttachmentOwnerRegistry();
    resolver = new CashMovementAttachmentOwnerResolver(
      { exists } as unknown as Repository<CashMovement>,
      registry,
    );
  });

  it('se registra como dueño cash_movement al iniciar el módulo', () => {
    resolver.onModuleInit();
    expect(registry.find(AttachmentOwnerType.CASH_MOVEMENT)).toBe(resolver);
  });

  it('el dueño de la distribuidora existe: no lanza, y la consulta lleva el tenant', async () => {
    exists.mockResolvedValue(true);
    await expect(resolver.assertOwner('a1', 'd1')).resolves.toBeUndefined();
    expect(exists).toHaveBeenCalledWith({
      where: { movementId: 'a1', distributorId: 'd1' },
    });
  });

  it('inexistente o de otra distribuidora es 404', async () => {
    exists.mockResolvedValue(false);
    await expect(resolver.assertOwner('a1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('no implementa isOwnedByUser: el chofer no accede', () => {
    expect('isOwnedByUser' in resolver).toBe(false);
  });
});
