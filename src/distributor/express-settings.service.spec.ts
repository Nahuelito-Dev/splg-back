import { BadRequestException } from '@nestjs/common';
import { ExpressSettingsService } from './express-settings.service';
import { ModuleConfigService } from './module-config.service';
import { ConfigurableProcess } from './entities/module-config.entity';

describe('ExpressSettingsService', () => {
  let configs: {
    parametros: jest.Mock;
    fila: jest.Mock;
    guardar: jest.Mock;
  };
  let service: ExpressSettingsService;

  beforeEach(() => {
    configs = {
      parametros: jest.fn().mockResolvedValue(null),
      fila: jest.fn().mockResolvedValue(null),
      guardar: jest.fn().mockResolvedValue(undefined),
    };
    service = new ExpressSettingsService(
      configs as unknown as ModuleConfigService,
    );
  });

  it('sin distribuidora devuelve los de omisión sin ir a la base', async () => {
    expect((await service.obtener(null)).enabled).toBe(false);
    expect(configs.parametros).not.toHaveBeenCalled();
  });

  it('guarda una copia de un minuto por distribuidora y guardar la descarta', async () => {
    configs.parametros.mockResolvedValue({
      enabled: true,
      surchargeAmount: 900,
    });

    expect((await service.obtener('d1')).surchargeAmount).toBe(900);
    await service.obtener('d1');
    expect(configs.parametros).toHaveBeenCalledTimes(1);
    expect(configs.parametros).toHaveBeenCalledWith(
      'd1',
      ConfigurableProcess.EXPRESS_DISPATCH,
    );

    configs.parametros.mockResolvedValue({
      enabled: true,
      surchargeAmount: 1200,
    });
    await service.guardar('d1', { enabled: true, surchargeAmount: 1200 }, 'u1');
    expect((await service.obtener('d1')).surchargeAmount).toBe(1200);
  });

  it('vigentes informa isDefault y quién la tocó', async () => {
    const fecha = new Date('2026-10-17T10:00:00Z');
    configs.fila.mockResolvedValue({
      params: { enabled: true },
      updatedAt: fecha,
      updatedByUserId: 'u1',
    });

    const v = await service.vigentes('d1');

    expect(v.enabled).toBe(true);
    expect(v.isDefault).toBe(false);
    expect(v.updatedAt).toBe(fecha);
    expect(v.updatedByUserId).toBe('u1');
    expect(
      (
        await new ExpressSettingsService(
          configs as unknown as ModuleConfigService,
        ).vigentes('x')
      ).isDefault,
    ).toBe(false);
  });

  it('guardar persiste sólo lo que vino', async () => {
    await service.guardar('d1', { enabled: true, surchargeAmount: 700 }, 'u1');
    expect(configs.guardar).toHaveBeenCalledWith(
      'd1',
      ConfigurableProcess.EXPRESS_DISPATCH,
      { enabled: true, surchargeAmount: 700 },
      'u1',
    );
  });

  it('rechaza un horario que no empieza antes de terminar', async () => {
    await expect(
      service.guardar('d1', { serviceFrom: '20:00', serviceTo: '08:00' }, 'u1'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.guardar('d1', { serviceFrom: '21:00' }, 'u1'),
    ).rejects.toThrow(BadRequestException);
    expect(configs.guardar).not.toHaveBeenCalled();
  });
});
