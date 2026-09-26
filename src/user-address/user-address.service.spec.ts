import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { UserAddressService } from './user-address.service';
import { UserAddress } from './entities/user-address.entity';
import { UsersService } from '../users/users.service';

/**
 * Las direcciones son de su dueño: un cliente sólo ve, cambia y borra las
 * suyas, y crea siempre para sí mismo. Hay a lo sumo una predeterminada.
 */
describe('UserAddressService', () => {
  let service: UserAddressService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    softRemove: jest.Mock;
  };
  let users: { findById: jest.Mock };

  const direccion = (over: Partial<UserAddress> = {}): UserAddress =>
    ({
      addressId: 'a1',
      userId: 'u1',
      isDefault: false,
      ...over,
    }) as UserAddress;

  const alta = {
    user_id: 'otro',
    street: 'Mitre 1',
    city: 'Posadas',
    latitude: '-27.4',
    longitude: '-55.9',
  };

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((d: Partial<UserAddress>) => d),
      save: jest.fn((d: UserAddress) => Promise.resolve(d)),
      softRemove: jest.fn(),
    };
    users = { findById: jest.fn().mockResolvedValue({ user_id: 'u1' }) };
    service = new UserAddressService(
      repo as unknown as Repository<UserAddress>,
      users as unknown as UsersService,
    );
  });

  it('un cliente crea siempre para sí mismo, aunque mande otro user_id', async () => {
    const d = await service.create(alta, 'u1');
    expect(d.userId).toBe('u1');
  });

  it('latitud y longitud se guardan como un punto [lng, lat]', async () => {
    const d = await service.create(alta, 'u1');
    expect(d.location).toEqual({ type: 'Point', coordinates: [-55.9, -27.4] });
    expect(d).not.toHaveProperty('latitude');
  });

  it('latitud y longitud se cambian juntas', async () => {
    repo.findOne.mockResolvedValue(direccion());
    await expect(
      service.update('a1', { latitude: '-27.5' }, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('el usuario de la dirección tiene que existir', async () => {
    users.findById.mockResolvedValue(null);
    await expect(service.create(alta)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('un cliente no ve la dirección de otro', async () => {
    repo.findOne.mockResolvedValue(direccion());
    await expect(service.findOne('a1', 'otro')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('un cliente no lista las direcciones de otro', async () => {
    await expect(service.findByUserId('u1', 'otro')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('marcar como predeterminada desmarca las demás', async () => {
    const otra = direccion({ addressId: 'a2', isDefault: true });
    repo.findOne.mockResolvedValue(direccion());
    repo.find.mockResolvedValue([otra]);

    const r = await service.setAsDefault('a1', 'u1');

    expect(r.isDefault).toBe(true);
    expect(otra.isDefault).toBe(false);
  });

  it('al borrar la predeterminada, pasa a serlo la más reciente', async () => {
    const otra = direccion({ addressId: 'a2' });
    repo.findOne.mockResolvedValue(direccion({ isDefault: true }));
    repo.find.mockResolvedValue([otra]);

    await expect(service.remove('a1', 'u1')).resolves.toEqual({
      message: 'Address deleted successfully',
      addressId: 'a1',
    });
    expect(otra.isDefault).toBe(true);
  });
});
