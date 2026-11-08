import { ConfigurableProcess } from './entities/module-config.entity';
import { ContainerChargeSettingsService } from './container-charge-settings.service';

describe('ContainerChargeSettingsService', () => {
  const configs = {
    parametros: jest.fn(),
    guardar: jest.fn(),
  };
  const service = new ContainerChargeSettingsService(configs as never);

  beforeEach(() => jest.clearAllMocks());

  it('sin fila queda apagado', async () => {
    configs.parametros.mockResolvedValue(null);
    await expect(service.vigentes('dist-1')).resolves.toEqual({
      enabled: false,
    });
    expect(configs.parametros).toHaveBeenCalledWith(
      'dist-1',
      ConfigurableProcess.CONTAINER_CHARGE,
    );
  });

  it('guarda el booleano como 0 o 1', async () => {
    await expect(service.guardar('dist-1', true, 'admin-1')).resolves.toEqual({
      enabled: true,
    });
    expect(configs.guardar).toHaveBeenCalledWith(
      'dist-1',
      ConfigurableProcess.CONTAINER_CHARGE,
      { enabled: 1 },
      'admin-1',
    );
  });
});
