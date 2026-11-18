import { Repository } from 'typeorm';
import { Car } from '../../car/entities/car.entity';
import { sumarDias } from '../../common/utils/dias-argentina';
import { MaintenanceTask } from '../entities/maintenance-task.entity';
import { VehicleUsageLog } from '../entities/vehicle-usage-log.entity';
import { MaintenanceForecastService } from './maintenance-forecast.service';
import { TareaProyectada } from './maintenance-forecast.service';

const HOY = new Date('2026-10-30T15:00:00Z');
const PARAMS = { decay: 0.7, minSampleDays: 30, usageStaleDays: 14 };

const auto = (carId: string, typeCar = 'Camioneta', odometerKm = 10_000) =>
  ({ carId, typeCar, odometerKm }) as Car;

const uso = (carId: string, n: number, km: number) =>
  Array.from({ length: n }, (_, i) => ({
    carId,
    day: sumarDias('2026-10-30', -i),
    km,
  })) as unknown as VehicleUsageLog[];

describe('MaintenanceForecastService', () => {
  let find: jest.Mock;
  let update: jest.Mock;
  let servicio: MaintenanceForecastService;

  beforeEach(() => {
    find = jest.fn().mockResolvedValue([]);
    update = jest.fn().mockResolvedValue(undefined);
    servicio = new MaintenanceForecastService(
      { find } as unknown as Repository<VehicleUsageLog>,
      { update } as unknown as Repository<MaintenanceTask>,
    );
  });

  describe('consumos', () => {
    it('sin vehículos no consulta nada', async () => {
      const r = await servicio.consumos('d1', [], PARAMS, HOY);
      expect(r.size).toBe(0);
      expect(find).not.toHaveBeenCalled();
    });

    it('usa el historial propio cuando alcanza', async () => {
      find.mockResolvedValue(uso('a', 60, 80));
      const r = await servicio.consumos('d1', [auto('a')], PARAMS, HOY);
      expect(r.get('a')).toMatchObject({ source: 'own', diasDeHistorial: 60 });
      expect(r.get('a')?.kmPorDia).toBeCloseTo(80, 3);
    });

    it('sin historial propio toma el promedio de los vehículos del mismo tipo', async () => {
      find.mockResolvedValue([...uso('a', 60, 80), ...uso('b', 60, 40)]);
      const cars = [auto('a'), auto('b'), auto('c'), auto('d', 'Camión')];
      const r = await servicio.consumos('d1', cars, PARAMS, HOY);

      expect(r.get('c')).toMatchObject({ source: 'fleet_average' });
      expect(r.get('c')?.kmPorDia).toBeCloseTo(60, 3);
      expect(r.get('d')).toBeNull(); // el único de su tipo: no hay con quién promediar
    });

    it('un historial más corto que la muestra mínima no cuenta como propio', async () => {
      find.mockResolvedValue([...uso('a', 60, 80), ...uso('b', 10, 10)]);
      const r = await servicio.consumos(
        'd1',
        [auto('a'), auto('b')],
        PARAMS,
        HOY,
      );
      expect(r.get('b')).toMatchObject({ source: 'fleet_average' });
      expect(r.get('b')?.kmPorDia).toBeCloseTo(80, 3);
    });

    it('un vehículo con el uso viejo toma el promedio de la flota y marca la fuente', async () => {
      const viejo = Array.from({ length: 40 }, (_, i) => ({
        carId: 'v',
        day: sumarDias('2026-10-30', -(40 + i)),
        km: 90,
      })) as unknown as VehicleUsageLog[];
      find.mockResolvedValue([...uso('a', 60, 80), ...viejo]);
      const r = await servicio.consumos(
        'd1',
        [auto('a'), auto('v')],
        PARAMS,
        HOY,
      );
      expect(r.get('v')).toMatchObject({
        source: 'fleet_average',
        desactualizado: false,
      });
      expect(r.get('v')?.kmPorDia).toBeCloseTo(80, 3);
    });

    it('un ritmo propio por debajo del piso toma el promedio de la flota', async () => {
      find.mockResolvedValue([...uso('a', 60, 80), ...uso('b', 60, 2)]);
      const r = await servicio.consumos(
        'd1',
        [auto('a'), auto('b')],
        PARAMS,
        HOY,
      );
      expect(r.get('b')).toMatchObject({ source: 'fleet_average' });
      expect(r.get('b')?.kmPorDia).toBeCloseTo(80, 3);
    });

    it('lee sólo el registro de la distribuidora y de los vehículos pedidos', async () => {
      await servicio.consumos('d1', [auto('a')], PARAMS, HOY);
      const donde = (
        find.mock.calls[0] as [{ where: Record<string, unknown> }]
      )[0].where;
      expect(donde.distributorId).toBe('d1');
    });
  });

  describe('proyectar', () => {
    const tarea = (over: Partial<MaintenanceTask>) =>
      ({ dueAt: null, dueKm: null, ...over }) as MaintenanceTask;

    it('sin consumo, una tarea por km queda en observación', () => {
      const r = servicio.proyectar(
        tarea({ dueKm: 11_000 }),
        auto('a'),
        null,
        HOY,
      );
      expect(r.enObservacion).toBe(true);
    });

    it('no proyecta por kilometraje más allá del horizonte y manda la fecha', () => {
      const consumo = {
        kmPorDia: 6,
        source: 'fleet_average' as const,
        diasDeHistorial: 0,
        ultimoDia: null,
        desactualizado: false,
        muestras: [],
      };
      const dueAt = new Date('2026-12-15T00:00:00Z');
      const r = servicio.proyectar(
        tarea({ dueKm: 90_000, dueAt }),
        auto('a'),
        consumo,
        HOY,
      );
      expect(r.porKilometraje).toBeNull();
      expect(r.fecha).toEqual(dueAt);
      const sinFecha = servicio.proyectar(
        tarea({ dueKm: 90_000 }),
        auto('a'),
        consumo,
        HOY,
      );
      expect(sinFecha.porKilometraje).toBeNull();
      expect(sinFecha.enObservacion).toBe(true);
    });

    it('corrige por la estacionalidad del mes en que cae el vencimiento', async () => {
      // Octubre rinde 50 km y noviembre 100: un vencimiento en noviembre llega antes.
      const noviembre = Array.from({ length: 20 }, (_, i) => ({
        carId: 'a',
        day: `2025-11-${String(i + 1).padStart(2, '0')}`,
        km: 100,
      }));
      find.mockResolvedValue([...uso('a', 60, 50), ...noviembre]);
      const consumos = await servicio.consumos('d1', [auto('a')], PARAMS, HOY);
      const consumo = consumos.get('a') ?? null;
      const sinEstacion = servicio.proyectar(
        tarea({ dueKm: 10_600 }),
        auto('a'),
        consumo && { ...consumo, muestras: [] },
        HOY,
      );
      const conEstacion = servicio.proyectar(
        tarea({ dueKm: 10_600 }),
        auto('a'),
        consumo,
        HOY,
      );

      expect(conEstacion.porKilometraje).not.toBeNull();
      expect(conEstacion.porKilometraje?.getTime()).toBeLessThan(
        sinEstacion.porKilometraje?.getTime() ?? 0,
      );
    });
  });

  describe('guardarPredicciones', () => {
    const proy = (
      predictedDueAt: Date | null,
      nueva: Date | null,
    ): TareaProyectada =>
      ({
        task: { taskId: 't1', predictedDueAt } as MaintenanceTask,
        consumo: null,
        proyeccion: { porKilometraje: nueva },
      }) as unknown as TareaProyectada;

    it('escribe la tarea cuya proyección cambió', async () => {
      const nueva = new Date('2026-12-01T15:00:00Z');
      const n = await servicio.guardarPredicciones([proy(null, nueva)]);
      expect(n).toBe(1);
      expect(update).toHaveBeenCalledWith(
        { taskId: 't1' },
        { predictedDueAt: nueva, firstPredictedDueAt: nueva },
      );
    });

    it('conserva la primera proyección cuando la fecha se corre', async () => {
      const primera = new Date('2026-12-01T15:00:00Z');
      const nueva = new Date('2026-12-10T15:00:00Z');
      const tarea = proy(primera, nueva);
      tarea.task.firstPredictedDueAt = primera;
      await servicio.guardarPredicciones([tarea]);
      expect(update).toHaveBeenCalledWith(
        { taskId: 't1' },
        { predictedDueAt: nueva },
      );
      expect(tarea.task.firstPredictedDueAt).toEqual(primera);
    });

    it('no vuelve a escribir la que no se movió más de un día', async () => {
      const base = new Date('2026-12-01T15:00:00Z');
      const n = await servicio.guardarPredicciones([
        proy(base, new Date(base.getTime() + 3_600_000)),
        proy(null, null),
      ]);
      expect(n).toBe(0);
      expect(update).not.toHaveBeenCalled();
    });

    it('limpia la predicción cuando ya no hay proyección por km', async () => {
      const n = await servicio.guardarPredicciones([
        proy(new Date('2026-12-01T15:00:00Z'), null),
      ]);
      expect(n).toBe(1);
      expect(update).toHaveBeenCalledWith(
        { taskId: 't1' },
        { predictedDueAt: null },
      );
    });
  });
});
