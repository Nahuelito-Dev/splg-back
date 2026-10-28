import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { InsuranceInstallment } from '../entities/insurance-installment.entity';
import { InsurancePolicy } from '../entities/insurance-policy.entity';
import {
  InsuranceInstallmentAttachmentOwnerResolver,
  InsurancePolicyAttachmentOwnerResolver,
} from './insurance-attachment-owners';

describe('dueños de adjuntos del seguro', () => {
  let registry: AttachmentOwnerRegistry;
  let existe: jest.Mock;

  beforeEach(() => {
    registry = new AttachmentOwnerRegistry();
    existe = jest.fn();
  });

  it('la póliza se registra y 404 si es de otra distribuidora', async () => {
    const r = new InsurancePolicyAttachmentOwnerResolver(
      { exists: existe } as unknown as Repository<InsurancePolicy>,
      registry,
    );
    r.onModuleInit();
    expect(registry.find(AttachmentOwnerType.INSURANCE_POLICY)).toBe(r);
    expect('isOwnedByUser' in r).toBe(false); // un chofer no accede

    existe.mockResolvedValue(true);
    await expect(r.assertOwner('p1', 'd1')).resolves.toBeUndefined();
    expect(existe).toHaveBeenCalledWith({
      where: { policyId: 'p1', distributorId: 'd1' },
    });
    existe.mockResolvedValue(false);
    await expect(r.assertOwner('p1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('la cuota se registra y 404 si es de otra distribuidora', async () => {
    const r = new InsuranceInstallmentAttachmentOwnerResolver(
      { exists: existe } as unknown as Repository<InsuranceInstallment>,
      registry,
    );
    r.onModuleInit();
    expect(registry.find(AttachmentOwnerType.INSURANCE_INSTALLMENT)).toBe(r);
    expect('isOwnedByUser' in r).toBe(false);

    existe.mockResolvedValue(false);
    await expect(r.assertOwner('q1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(existe).toHaveBeenCalledWith({
      where: { installmentId: 'q1', distributorId: 'd2' },
    });
  });
});
