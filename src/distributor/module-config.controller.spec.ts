import { ModuleConfigController } from './module-config.controller';
import { DispatchSettingsService } from './dispatch-settings.service';
import { ScheduledTasksSettingsService } from './scheduled-tasks-settings.service';
import { ProcessConfigService } from './process-config.service';

describe('ModuleConfigController', () => {
  let controller: ModuleConfigController;
  let dispatch: { vigentes: jest.Mock; guardar: jest.Mock };
  let tasks: {
    vigentes: jest.Mock;
    guardar: jest.Mock;
    guardarHoraDeLaEmpresa: jest.Mock;
  };
  let processes: {
    vigentes: jest.Mock;
    guardar: jest.Mock;
    todos: jest.Mock;
    procesoConfigurable: jest.Mock;
  };

  beforeEach(() => {
    dispatch = {
      vigentes: jest.fn().mockResolvedValue({ offerTtlSeconds: 30 }),
      guardar: jest.fn().mockResolvedValue({ offerTtlSeconds: 90 }),
    };
    tasks = {
      vigentes: jest.fn().mockResolvedValue({ fleetAlertHour: 8 }),
      guardar: jest.fn().mockResolvedValue({ fleetAlertHour: 20 }),
      guardarHoraDeLaEmpresa: jest
        .fn()
        .mockResolvedValue({ fleetAlertHour: 20 }),
    };
    processes = {
      vigentes: jest.fn().mockResolvedValue({ process: 'repurchase' }),
      guardar: jest.fn().mockResolvedValue({ process: 'repurchase' }),
      todos: jest.fn().mockResolvedValue([{ process: 'repurchase' }]),
      procesoConfigurable: jest.fn((p: string) => p),
    };
    controller = new ModuleConfigController(
      dispatch as unknown as DispatchSettingsService,
      tasks as unknown as ScheduledTasksSettingsService,
      processes as unknown as ProcessConfigService,
    );
  });

  it('despacho: GET lee lo vigente de la distribuidora y PUT guarda con el usuario que lo pide', async () => {
    expect(await controller.getDispatch('d1')).toEqual({ offerTtlSeconds: 30 });
    expect(dispatch.vigentes).toHaveBeenCalledWith('d1');

    const cuerpo = { radiusStepsKm: [5], offerTtlSeconds: 90 };
    expect(await controller.putDispatch(cuerpo, 'd1', 'u1')).toEqual({
      offerTtlSeconds: 90,
    });
    expect(dispatch.guardar).toHaveBeenCalledWith('d1', cuerpo, 'u1');
  });

  it('tareas programadas: GET lee lo vigente de la distribuidora y PUT guarda con el usuario que lo pide', async () => {
    expect(await controller.getScheduledTasks('d1')).toEqual({
      fleetAlertHour: 8,
    });
    expect(tasks.vigentes).toHaveBeenCalledWith('d1');

    const cuerpo = { fleetAlertHour: 20, dispatchRetrySeconds: 30 };
    expect(await controller.putScheduledTasks(cuerpo, 'd1', 'u1')).toEqual({
      fleetAlertHour: 20,
    });
    expect(tasks.guardar).toHaveBeenCalledWith('d1', cuerpo, 'u1');

    await controller.putScheduledTasksV2({ fleetAlertHour: 5 }, 'd1', 'u1');
    expect(tasks.guardarHoraDeLaEmpresa).toHaveBeenCalledWith(
      'd1',
      { fleetAlertHour: 5 },
      'u1',
    );
  });

  it('procesos automáticos: lista, lee y guarda con el usuario que lo pide', async () => {
    expect(await controller.getProcesses('d1')).toEqual([
      { process: 'repurchase' },
    ]);
    expect(processes.todos).toHaveBeenCalledWith('d1');

    await controller.getProcess('repurchase', 'd1');
    expect(processes.vigentes).toHaveBeenCalledWith('d1', 'repurchase');

    const cuerpo = { anticipationDays: 5 };
    await controller.putProcess('repurchase', cuerpo, 'd1', 'u1');
    expect(processes.guardar).toHaveBeenCalledWith(
      'd1',
      'repurchase',
      cuerpo,
      'u1',
    );
  });
});
