import { NotFoundException } from '@nestjs/common';
import type { DistributorService } from '../../distributor/distributor.service';
import type { ScheduledTasksSettingsService } from '../../distributor/scheduled-tasks-settings.service';
import { PlatformScheduleService } from './platform-schedule.service';

function armar(existe = true) {
  const distributors = {
    findOne: jest.fn(() =>
      existe
        ? Promise.resolve({ distributorId: 'd1' })
        : Promise.reject(new NotFoundException('Distribuidora no encontrada')),
    ),
  };
  const tasks = {
    vigentes: jest.fn().mockResolvedValue({ dispatchRetrySeconds: 15 }),
    guardarDeLaPlataforma: jest
      .fn()
      .mockResolvedValue({ dispatchRetrySeconds: 30 }),
  };
  const service = new PlatformScheduleService(
    distributors as unknown as DistributorService,
    tasks as unknown as ScheduledTasksSettingsService,
  );
  return { service, tasks };
}

describe('PlatformScheduleService', () => {
  it('lee y guarda las frecuencias de la empresa como plataforma', async () => {
    const { service, tasks } = armar();
    expect(await service.vigentes('d1')).toEqual({ dispatchRetrySeconds: 15 });
    expect(
      await service.guardar('d1', { dispatchRetrySeconds: 30 }, 'super'),
    ).toEqual({ dispatchRetrySeconds: 30 });
    expect(tasks.guardarDeLaPlataforma).toHaveBeenCalledWith(
      'd1',
      { dispatchRetrySeconds: 30 },
      'super',
    );
  });

  it('una empresa inexistente o dada de baja es 404 y no guarda nada', async () => {
    const { service, tasks } = armar(false);
    await expect(service.vigentes('x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.guardar('x', { dispatchRetrySeconds: 30 }, 'super'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tasks.vigentes).not.toHaveBeenCalled();
    expect(tasks.guardarDeLaPlataforma).not.toHaveBeenCalled();
  });
});
