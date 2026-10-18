import { ExpressConfigController } from './express-config.controller';

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
});
