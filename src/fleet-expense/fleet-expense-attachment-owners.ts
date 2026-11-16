import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../attachment/attachment-owner.registry';
import { AttachmentOwnerType } from '../attachment/entities/attachment.entity';
import { AttachmentOwnerResolver } from '../attachment/ports/attachment-owner-resolver.port';
import { FuelLoad } from './entities/fuel-load.entity';
import { TrafficFine } from './entities/traffic-fine.entity';
import { VehicleAccident } from './entities/vehicle-accident.entity';

/** Dueño `fuel_load` de los adjuntos (el comprobante). El chofer accede a las que cargó él. */
@Injectable()
export class FuelLoadAttachmentOwnerResolver
  implements AttachmentOwnerResolver, OnModuleInit
{
  readonly ownerType = AttachmentOwnerType.FUEL_LOAD;

  constructor(
    @InjectRepository(FuelLoad) private readonly loads: Repository<FuelLoad>,
    private readonly registry: AttachmentOwnerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertOwner(ownerId: string, distributorId: string): Promise<void> {
    const existe = await this.loads.exists({
      where: { fuelLoadId: ownerId, distributorId },
    });
    if (!existe) {
      throw new NotFoundException('Carga de combustible no encontrada');
    }
  }

  isOwnedByUser(
    ownerId: string,
    userId: string,
    distributorId: string,
  ): Promise<boolean> {
    return this.loads.exists({
      where: { fuelLoadId: ownerId, distributorId, createdByUserId: userId },
    });
  }
}

/** Dueño `traffic_fine` de los adjuntos (la copia del acta). Un chofer no accede. */
@Injectable()
export class TrafficFineAttachmentOwnerResolver
  implements AttachmentOwnerResolver, OnModuleInit
{
  readonly ownerType = AttachmentOwnerType.TRAFFIC_FINE;

  constructor(
    @InjectRepository(TrafficFine)
    private readonly fines: Repository<TrafficFine>,
    private readonly registry: AttachmentOwnerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertOwner(ownerId: string, distributorId: string): Promise<void> {
    const existe = await this.fines.exists({
      where: { fineId: ownerId, distributorId },
    });
    if (!existe) {
      throw new NotFoundException('Multa no encontrada');
    }
  }
}

/** Dueño `traffic_fine_payment` de los adjuntos (el comprobante de pago de la multa). Entra sólo por `POST /traffic-fines/:id/receipt`. */
@Injectable()
export class TrafficFinePaymentAttachmentOwnerResolver
  implements AttachmentOwnerResolver, OnModuleInit
{
  readonly ownerType = AttachmentOwnerType.TRAFFIC_FINE_PAYMENT;

  constructor(
    @InjectRepository(TrafficFine)
    private readonly fines: Repository<TrafficFine>,
    private readonly registry: AttachmentOwnerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertOwner(ownerId: string, distributorId: string): Promise<void> {
    const existe = await this.fines.exists({
      where: { fineId: ownerId, distributorId },
    });
    if (!existe) {
      throw new NotFoundException('Multa no encontrada');
    }
  }
}

/** Dueño `vehicle_accident` de los adjuntos (fotos, denuncia). El chofer accede a los que reportó él. */
@Injectable()
export class VehicleAccidentAttachmentOwnerResolver
  implements AttachmentOwnerResolver, OnModuleInit
{
  readonly ownerType = AttachmentOwnerType.VEHICLE_ACCIDENT;

  constructor(
    @InjectRepository(VehicleAccident)
    private readonly accidents: Repository<VehicleAccident>,
    private readonly registry: AttachmentOwnerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertOwner(ownerId: string, distributorId: string): Promise<void> {
    const existe = await this.accidents.exists({
      where: { accidentId: ownerId, distributorId },
    });
    if (!existe) {
      throw new NotFoundException('Siniestro no encontrado');
    }
  }

  isOwnedByUser(
    ownerId: string,
    userId: string,
    distributorId: string,
  ): Promise<boolean> {
    return this.accidents.exists({
      where: { accidentId: ownerId, distributorId, createdByUserId: userId },
    });
  }
}
