import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { AttachmentOwnerResolver } from '../../attachment/ports/attachment-owner-resolver.port';
import { InsuranceInstallment } from '../entities/insurance-installment.entity';
import { InsurancePolicy } from '../entities/insurance-policy.entity';

/** Dueño `insurance_policy` de los adjuntos (la copia de la póliza). Un chofer no accede. */
@Injectable()
export class InsurancePolicyAttachmentOwnerResolver
  implements AttachmentOwnerResolver, OnModuleInit
{
  readonly ownerType = AttachmentOwnerType.INSURANCE_POLICY;

  constructor(
    @InjectRepository(InsurancePolicy)
    private readonly policies: Repository<InsurancePolicy>,
    private readonly registry: AttachmentOwnerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertOwner(ownerId: string, distributorId: string): Promise<void> {
    const existe = await this.policies.exists({
      where: { policyId: ownerId, distributorId },
    });
    if (!existe) {
      throw new NotFoundException('Póliza no encontrada');
    }
  }
}

/** Dueño `insurance_installment` de los adjuntos (el comprobante de pago). Un chofer no accede. */
@Injectable()
export class InsuranceInstallmentAttachmentOwnerResolver
  implements AttachmentOwnerResolver, OnModuleInit
{
  readonly ownerType = AttachmentOwnerType.INSURANCE_INSTALLMENT;

  constructor(
    @InjectRepository(InsuranceInstallment)
    private readonly installments: Repository<InsuranceInstallment>,
    private readonly registry: AttachmentOwnerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertOwner(ownerId: string, distributorId: string): Promise<void> {
    const existe = await this.installments.exists({
      where: { installmentId: ownerId, distributorId },
    });
    if (!existe) {
      throw new NotFoundException('Cuota no encontrada');
    }
  }
}
