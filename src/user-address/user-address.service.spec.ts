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
    preload: jest.Mock;
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
      preload: jest.fn((d: Partial<UserAddress>) =>
        Promise.resolve({ ...direccion({ isDefault: true }), ...d }),
      ),
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

  it('un cliente crea para sí mismo con el user_id de su token, lo mande o no', async () => {
    const sin = await service.create({ ...alta, user_id: undefined }, 'u1');
    expect(sin.userId).toBe('u1');
    const propio = await service.create({ ...alta, user_id: 'U1' }, 'u1');
    expect(propio.userId).toBe('u1');
  });

  it('un cliente que manda el user_id de OTRO recibe 403 y no se guarda nada', async () => {
    await expect(service.create(alta, 'u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('el administrador general tiene que indicar el dueño (400 si falta)', async () => {
    await expect(
      service.create({ ...alta, user_id: undefined }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const d = await service.create(alta);
    expect(d.userId).toBe('otro');
  });

  it('latitud y longitud se guardan como un punto [lng, lat]', async () => {
    const d = await service.create({ ...alta, user_id: undefined }, 'u1');
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
      message: 'Dirección dada de baja',
      addressId: 'a1',
    });
    expect(otra.isDefault).toBe(true);
  });

  describe('desmarcar la principal no deja al usuario sin ninguna', () => {
    it('pasa a ser principal la más reciente de las otras', async () => {
      repo.findOne.mockResolvedValue(direccion({ isDefault: true }));
      const otra = direccion({ addressId: 'a2' });
      repo.find.mockResolvedValue([otra]);
      const d = await service.update('a1', { isDefault: false }, null);
      expect(d.isDefault).toBe(false);
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ addressId: 'a2', isDefault: true }),
      );
    });

    /**
     * La base no admite dos principales a la vez (`UQ_user_address_principal`):
     * al pasar la principal a otra, la vieja se guarda desmarcada ANTES de
     * marcar la nueva.
     */
    it('desmarca la vieja ANTES de marcar la nueva (nunca dos principales a la vez)', async () => {
      const guardados: Array<[string, boolean]> = [];
      repo.save.mockImplementation((d: UserAddress) => {
        guardados.push([d.addressId, d.isDefault]);
        return Promise.resolve(d);
      });
      repo.findOne.mockResolvedValue(direccion({ isDefault: true }));
      repo.find.mockResolvedValue([direccion({ addressId: 'a2' })]);

      await service.update('a1', { isDefault: false }, null);

      expect(guardados[0]).toEqual(['a1', false]);
      expect(guardados[1]).toEqual(['a2', true]);
    });

    it('al borrar la principal, también la suelta antes de promover a la otra', async () => {
      const guardados: Array<[string, boolean]> = [];
      repo.save.mockImplementation((d: UserAddress) => {
        guardados.push([d.addressId, d.isDefault]);
        return Promise.resolve(d);
      });
      repo.findOne.mockResolvedValue(direccion({ isDefault: true }));
      repo.find.mockResolvedValue([direccion({ addressId: 'a2' })]);

      await service.remove('a1', 'u1');

      expect(guardados).toEqual([
        ['a1', false],
        ['a2', true],
      ]);
    });

    it('si es la única, sigue siendo la principal', async () => {
      repo.findOne.mockResolvedValue(direccion({ isDefault: true }));
      repo.find.mockResolvedValue([]);
      const d = await service.update('a1', { isDefault: false }, null);
      expect(d.isDefault).toBe(true);
    });
  });
});
