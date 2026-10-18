import { NotFoundException } from '@nestjs/common';
import { ObjectLiteral, Repository } from 'typeorm';
import { AttachmentOwnerRegistry } from '../attachment/attachment-owner.registry';
import { AttachmentOwnerResolver } from '../attachment/ports/attachment-owner-resolver.port';
import { AttachmentOwnerType } from '../attachment/entities/attachment.entity';
import { OWNER_TYPES_DEL_CHOFER } from '../attachment/attachment.service';
import {
  FuelLoadAttachmentOwnerResolver,
  TrafficFineAttachmentOwnerResolver,
  VehicleAccidentAttachmentOwnerResolver,
} from './fleet-expense-attachment-owners';
import { FuelLoad } from './entities/fuel-load.entity';
import { TrafficFine } from './entities/traffic-fine.entity';
import { VehicleAccident } from './entities/vehicle-accident.entity';

describe('dueños de adjuntos de la flota ampliada', () => {
  let exists: jest.Mock;
  let registry: AttachmentOwnerRegistry;

  beforeEach(() => {
    exists = jest.fn();
    registry = new AttachmentOwnerRegistry();
  });

  const repo = <T extends ObjectLiteral>() =>
    ({ exists }) as unknown as Repository<T>;

  it('fuel_load: 404 si no es de la distribuidora; el chofer accede a las que cargó él', async () => {
    const resolver = new FuelLoadAttachmentOwnerResolver(
      repo<FuelLoad>(),
      registry,
    );
    resolver.onModuleInit();
    expect(registry.find(AttachmentOwnerType.FUEL_LOAD)).toBe(resolver);

    exists.mockResolvedValue(false);
    await expect(resolver.assertOwner('f1', 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    exists.mockResolvedValue(true);
    await expect(resolver.assertOwner('f1', 'd1')).resolves.toBeUndefined();

    await resolver.isOwnedByUser('f1', 'u1', 'd1');
    expect(exists).toHaveBeenLastCalledWith({
      where: { fuelLoadId: 'f1', distributorId: 'd1', createdByUserId: 'u1' },
    });
  });

  it('vehicle_accident: 404 si no es de la distribuidora; el chofer accede a los que reportó él', async () => {
    const resolver = new VehicleAccidentAttachmentOwnerResolver(
      repo<VehicleAccident>(),
      registry,
    );
    resolver.onModuleInit();
    exists.mockResolvedValue(false);
    await expect(resolver.assertOwner('s1', 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await resolver.isOwnedByUser('s1', 'u1', 'd1');
    expect(exists).toHaveBeenLastCalledWith({
      where: { accidentId: 's1', distributorId: 'd1', createdByUserId: 'u1' },
    });
  });

  it('traffic_fine: sólo el administrador (el chofer no tiene acceso)', async () => {
    const resolver = new TrafficFineAttachmentOwnerResolver(
      repo<TrafficFine>(),
      registry,
    );
    resolver.onModuleInit();
    exists.mockResolvedValue(false);
    await expect(resolver.assertOwner('m1', 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect('isOwnedByUser' in (resolver as AttachmentOwnerResolver)).toBe(
      false,
    );
    expect(OWNER_TYPES_DEL_CHOFER).not.toContain(
      AttachmentOwnerType.TRAFFIC_FINE,
    );
  });

  it('los tipos que el chofer sí toca tienen su verificación de dueño', () => {
    expect(OWNER_TYPES_DEL_CHOFER).toEqual(
      expect.arrayContaining([
        AttachmentOwnerType.FUEL_LOAD,
        AttachmentOwnerType.VEHICLE_ACCIDENT,
      ]),
    );
  });
});
