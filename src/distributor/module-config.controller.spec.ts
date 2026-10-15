import { ModuleConfigController } from './module-config.controller';
import { DispatchSettingsService } from './dispatch-settings.service';
import { ScheduledTasksSettingsService } from './scheduled-tasks-settings.service';

describe('ModuleConfigController', () => {
  let controller: ModuleConfigController;
  let dispatch: { vigentes: jest.Mock; guardar: jest.Mock };
  let tasks: { vigentes: jest.Mock; guardar: jest.Mock };

  beforeEach(() => {
    dispatch = {
      vigentes: jest.fn().mockResolvedValue({ offerTtlSeconds: 30 }),
      guardar: jest.fn().mockResolvedValue({ offerTtlSeconds: 90 }),
    };
    tasks = {
      vigentes: jest.fn().mockResolvedValue({ fleetAlertHour: 8 }),
      guardar: jest.fn().mockResolvedValue({ fleetAlertHour: 20 }),
    };
    controller = new ModuleConfigController(
      dispatch as unknown as DispatchSettingsService,
      tasks as unknown as ScheduledTasksSettingsService,
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

    const cuerpo = {
      dispatchRetrySeconds: 15,
      reservationActivationSeconds: 300,
      unpaidReservationExpirySeconds: 3600,
      unpaidMercadoPagoExpirySeconds: 1800,
      fleetAlertHour: 20,
    };
    expect(await controller.putScheduledTasks(cuerpo, 'd1', 'u1')).toEqual({
      fleetAlertHour: 20,
    });
    expect(tasks.guardar).toHaveBeenCalledWith('d1', cuerpo, 'u1');
  });
});
