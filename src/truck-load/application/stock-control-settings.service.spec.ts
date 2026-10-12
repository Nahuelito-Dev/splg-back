import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import type { ModuleConfigService } from '../../distributor/module-config.service';
import { StockControlSettingsService } from './stock-control-settings.service';

describe('StockControlSettingsService', () => {
  let configs: { parametros: jest.Mock; guardar: jest.Mock };
  let service: StockControlSettingsService;

  beforeEach(() => {
    configs = {
      parametros: jest.fn().mockResolvedValue(null),
      guardar: jest.fn().mockResolvedValue(undefined),
    };
    service = new StockControlSettingsService(
      configs as unknown as ModuleConfigService,
    );
  });

  it('sin configuración rige el default: no se exige carga abierta (D5)', async () => {
    expect(await service.obtener('dist')).toEqual({
      requireOpenTruckLoad: false,
    });
  });

  it('sólo un true explícito la activa (un texto "true" o un 1 no cuentan)', async () => {
    configs.parametros.mockResolvedValue({ requireOpenTruckLoad: true });
    expect((await service.obtener('dist')).requireOpenTruckLoad).toBe(true);
    configs.parametros.mockResolvedValue({ requireOpenTruckLoad: 'true' });
    expect((await service.obtener('dist')).requireOpenTruckLoad).toBe(false);
    configs.parametros.mockResolvedValue({ requireOpenTruckLoad: 1 });
    expect((await service.obtener('dist')).requireOpenTruckLoad).toBe(false);
  });

  it('guarda sólo el parámetro conocido en el proceso stock_control', async () => {
    await service.guardar('dist', { requireOpenTruckLoad: true }, 'admin-1');

    expect(configs.guardar).toHaveBeenCalledWith(
      'dist',
      ConfigurableProcess.STOCK_CONTROL,
      { requireOpenTruckLoad: true },
      'admin-1',
    );
  });
});
