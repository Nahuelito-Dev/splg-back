import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DistributorController } from './distributor.controller';
import { DistributorService } from './distributor.service';
import { Distributor } from './entities/distributor.entity';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';

describe('DistributorController — la distribuidora de la sesión', () => {
  const findOne = jest.fn();
  const controller = new DistributorController({
    findOne,
  } as unknown as DistributorService);

  beforeEach(() => findOne.mockReset());

  it('devuelve la distribuidora que resolvió el guard', async () => {
    findOne.mockResolvedValue({
      distributorId: 'd1',
      name: 'Jeny Gas',
      slug: 'jeny-gas',
    } as Distributor);
    const dto = await controller.findCurrent('d1');
    expect(findOne).toHaveBeenCalledWith('d1');
    expect(dto).toMatchObject({ name: 'Jeny Gas', slug: 'jeny-gas' });
  });

  it('sin distribuidora elegida contesta 404', async () => {
    await expect(controller.findCurrent(null)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  it('la abre a admin y super admin; el resto del recurso sigue siendo de plataforma', () => {
    const reflector = new Reflector();
    const handler = (name: keyof DistributorController) =>
      Reflect.get(DistributorController.prototype, name) as () => unknown;
    const current = reflector.getAllAndOverride<RoleType[]>(ROLES_KEY, [
      handler('findCurrent'),
      DistributorController,
    ]);
    const list = reflector.getAllAndOverride<RoleType[]>(ROLES_KEY, [
      handler('findAll'),
      DistributorController,
    ]);
    expect(current).toEqual([RoleType.ADMIN, RoleType.SUPER_ADMIN]);
    expect(list).toEqual([RoleType.SUPER_ADMIN]);
  });
});
