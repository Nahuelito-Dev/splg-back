import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProcessConfigService } from './process-config.service';
import { ModuleConfigService } from './module-config.service';
import { ConfigurableProcess } from './entities/module-config.entity';

describe('ProcessConfigService', () => {
  let service: ProcessConfigService;
  let configs: { parametros: jest.Mock; fila: jest.Mock; guardar: jest.Mock };

  beforeEach(() => {
    configs = {
      parametros: jest.fn().mockResolvedValue(null),
      fila: jest.fn().mockResolvedValue(null),
      guardar: jest.fn().mockResolvedValue(undefined),
    };
    service = new ProcessConfigService(
      configs as unknown as ModuleConfigService,
    );
  });

  it('un proceso que no es uno de los cinco es 404', () => {
    expect(() => service.procesoConfigurable('dispatch')).toThrow(
      NotFoundException,
    );
    expect(() => service.procesoConfigurable('inventado')).toThrow(
      NotFoundException,
    );
    expect(service.procesoConfigurable('repurchase')).toBe('repurchase');
  });

  it('sin configuración rigen los de omisión y isDefault es true', async () => {
    const v = await service.vigentes('d1', ConfigurableProcess.REPURCHASE);
    expect(v.isDefault).toBe(true);
    expect(v.params.anticipationDays).toBe(3);
    expect(v.updatedAt).toBeNull();
    expect(v.fields.length).toBeGreaterThan(0);
  });

  it('guardar valida, guarda sólo lo que vino y con el usuario', async () => {
    configs.fila.mockResolvedValue({
      params: { anticipationDays: 5 },
      updatedAt: new Date('2026-10-17T10:00:00Z'),
      updatedByUserId: 'u1',
    });
    const v = await service.guardar(
      'd1',
      ConfigurableProcess.REPURCHASE,
      { anticipationDays: 5 },
      'u1',
    );
    expect(configs.guardar).toHaveBeenCalledWith(
      'd1',
      'repurchase',
      { anticipationDays: 5 },
      'u1',
    );
    expect(v.params.anticipationDays).toBe(5);
    expect(v.isDefault).toBe(false);
    expect(v.updatedByUserId).toBe('u1');
  });

  it('guardar con un parámetro inválido es 400 y no escribe', async () => {
    await expect(
      service.guardar(
        'd1',
        ConfigurableProcess.REPURCHASE,
        { anticipationDays: 99 },
        'u1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(configs.guardar).not.toHaveBeenCalled();
  });

  it('obtener lee la fila de la distribuidora pedida', async () => {
    configs.parametros.mockResolvedValue({ minOrders: 6 });
    const v = await service.obtener('d9', ConfigurableProcess.REPURCHASE);
    expect(configs.parametros).toHaveBeenCalledWith('d9', 'repurchase');
    expect(v.minOrders).toBe(6);
  });

  it('todos devuelve los cinco procesos (el express tiene su propia ruta)', async () => {
    expect(await service.todos('d1')).toHaveLength(5);
  });
});
