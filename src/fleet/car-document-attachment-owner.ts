import { Injectable, OnModuleInit } from '@nestjs/common';
import { AttachmentOwnerRegistry } from '../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../attachment/entities/attachment.entity';
import { AttachmentOwnerResolver } from '../attachment/ports/attachment-owner-resolver.port';
import { CarService } from '../car/car.service';

/** Registra al vehículo como dueño de adjuntos leíbles por M6. */
@Injectable()
export class CarDocumentAttachmentOwnerResolver
  implements AttachmentOwnerResolver, OnModuleInit
{
  readonly ownerType = AttachmentOwnerType.CAR_DOCUMENT;

  constructor(
    private readonly cars: CarService,
    private readonly registry: AttachmentOwnerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** 404 «Vehículo no encontrado» si no existe o es de otra distribuidora. */
  async assertOwner(ownerId: string, distributorId: string): Promise<void> {
    await this.cars.findOne(ownerId, distributorId);
  }
}
