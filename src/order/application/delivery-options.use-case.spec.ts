import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RoleType } from '../../common/constants/role-type.enum';
import { OrderDeliveryMode } from '../entities/order.entity';
import { DeliveryOptionsUseCase } from './delivery-options.use-case';
import { expressSettingsPorDefecto } from '../../distributor/express-settings';

const CLIENTE = { userId: 'cli-1', role: RoleType.CUSTOMER };
const ADMIN = { userId: 'adm-1', role: RoleType.ADMIN };

describe('DeliveryOptionsUseCase (CU-148)', () => {
  let addresses: { buscarDelUsuario: jest.Mock };
  let express: { evaluar: jest.Mock };
  let distributors: { getDefault: jest.Mock };
  let useCase: DeliveryOptionsUseCase;

  const disponible = {
    available: true,
    reason: null,
    message: null,
    settings: {
      ...expressSettingsPorDefecto(),
      enabled: true,
      surchargeAmount: 1500,
      estimatedMinutes: 40,
      standardEstimatedMinutes: 200,
    },
  };

  beforeEach(() => {
    addresses = {
      buscarDelUsuario: jest.fn().mockResolvedValue({ addressId: 'dir-1' }),
    };
    express = { evaluar: jest.fn().mockResolvedValue(disponible) };
    distributors = {
      getDefault: jest.fn().mockResolvedValue({ distributorId: 'dist-def' }),
    };
    useCase = new DeliveryOptionsUseCase(
      addresses as never,
      express as never,
      distributors as never,
    );
  });

  it('ofrece las dos modalidades con su recargo y tiempo estimado', async () => {
    const r = await useCase.execute({ addressId: 'dir-1' }, 'dist-1', CLIENTE);

    expect(r.addressId).toBe('dir-1');
    expect(r.options).toEqual([
      {
        mode: OrderDeliveryMode.STANDARD,
        available: true,
        reason: null,
        message: null,
        surchargeAmount: 0,
        estimatedMinutes: 200,
      },
      {
        mode: OrderDeliveryMode.EXPRESS,
        available: true,
        reason: null,
        message: null,
        surchargeAmount: 1500,
        estimatedMinutes: 40,
      },
    ]);
    expect(addresses.buscarDelUsuario).toHaveBeenCalledWith('dir-1', 'cli-1');
    expect(express.evaluar).toHaveBeenCalledWith('dist-1', {
      addressId: 'dir-1',
    });
  });

  it('si el express no está disponible muestra sólo la programada y explica por qué', async () => {
    express.evaluar.mockResolvedValue({
      ...disponible,
      available: false,
      reason: 'no_motorcycle_driver',
      message: 'No hay un chofer en moto disponible cerca',
    });

    const r = await useCase.execute({ addressId: 'dir-1' }, 'dist-1', CLIENTE);

    const [programada, rapida] = r.options;
    expect(programada.available).toBe(true);
    expect(rapida).toMatchObject({
      available: false,
      reason: 'no_motorcycle_driver',
      message: 'No hay un chofer en moto disponible cerca',
      surchargeAmount: 0,
    });
  });

  it('cliente sin X-Distributor: usa la distribuidora por defecto', async () => {
    await useCase.execute({ addressId: 'dir-1' }, null, CLIENTE);
    expect(express.evaluar).toHaveBeenCalledWith('dist-def', expect.anything());
  });

  it('sin ninguna distribuidora sólo ofrece la programada', async () => {
    distributors.getDefault.mockResolvedValue(null);

    const r = await useCase.execute({ addressId: 'dir-1' }, null, CLIENTE);

    expect(r.options[1]).toMatchObject({
      available: false,
      reason: 'disabled',
    });
    expect(express.evaluar).not.toHaveBeenCalled();
  });

  it('una dirección ajena es 404', async () => {
    addresses.buscarDelUsuario.mockResolvedValue(null);
    await expect(
      useCase.execute({ addressId: 'dir-9' }, 'dist-1', CLIENTE),
    ).rejects.toThrow(NotFoundException);
  });

  it('un cliente no consulta por otro (403)', async () => {
    await expect(
      useCase.execute(
        { addressId: 'dir-1', customerId: 'otro' },
        'dist-1',
        CLIENTE,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(addresses.buscarDelUsuario).not.toHaveBeenCalled();
  });

  it('el admin tiene que indicar el cliente (400) y entonces consulta su dirección', async () => {
    await expect(
      useCase.execute({ addressId: 'dir-1' }, 'dist-1', ADMIN),
    ).rejects.toThrow(BadRequestException);

    await useCase.execute(
      { addressId: 'dir-1', customerId: 'cli-7' },
      'dist-1',
      ADMIN,
    );
    expect(addresses.buscarDelUsuario).toHaveBeenCalledWith('dir-1', 'cli-7');
  });
});
