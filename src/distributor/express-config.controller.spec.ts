import { DistributorModule } from './distributor.module';
import { ExpressConfigController } from './express-config.controller';
import { ModuleConfigController } from './module-config.controller';

describe('ExpressConfigController', () => {
  let express: { vigentes: jest.Mock; guardar: jest.Mock };
  let controller: ExpressConfigController;

  beforeEach(() => {
    express = {
      vigentes: jest.fn().mockResolvedValue({ enabled: false }),
      guardar: jest.fn().mockResolvedValue({ enabled: true }),
    };
    controller = new ExpressConfigController(express as never);
  });

  it('GET lee la configuración de la distribuidora en contexto', async () => {
    await controller.get('dist-1');
    expect(express.vigentes).toHaveBeenCalledWith('dist-1');
  });

  it('PUT guarda con el usuario del token', async () => {
    await controller.put({ enabled: true }, 'dist-1', 'adm-1');
    expect(express.guardar).toHaveBeenCalledWith(
      'dist-1',
      { enabled: true },
      'adm-1',
    );
  });

  it('el módulo registra ExpressConfigController ANTES que ModuleConfigController: su ruta fija gana a `:process`', () => {
    const controladores = Reflect.getMetadata(
      'controllers',
      DistributorModule,
    ) as unknown[];

    const express = controladores.indexOf(ExpressConfigController);
    const generico = controladores.indexOf(ModuleConfigController);
    expect(express).toBeGreaterThanOrEqual(0);
    expect(generico).toBeGreaterThanOrEqual(0);
    expect(express).toBeLessThan(generico);
  });
});
