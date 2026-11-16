import { ContainerChargeConfigController } from './container-charge-config.controller';

describe('ContainerChargeConfigController', () => {
  const settings = { vigentes: jest.fn(), guardar: jest.fn() };
  const controller = new ContainerChargeConfigController(settings as never);

  beforeEach(() => jest.clearAllMocks());

  it('GET lee la distribuidora en contexto', async () => {
    settings.vigentes.mockResolvedValue({ enabled: false });
    await controller.get('dist-1');
    expect(settings.vigentes).toHaveBeenCalledWith('dist-1');
  });

  it('PUT guarda el interruptor con el actor autenticado', async () => {
    settings.guardar.mockResolvedValue({ enabled: true });
    await controller.put({ enabled: true }, 'dist-1', 'admin-1');
    expect(settings.guardar).toHaveBeenCalledWith('dist-1', true, 'admin-1');
  });
});
