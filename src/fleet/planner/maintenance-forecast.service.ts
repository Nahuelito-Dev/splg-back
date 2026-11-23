import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { Car } from '../../car/entities/car.entity';
import { diaArgentino, sumarDias } from '../../common/utils/dias-argentina';
import { ValoresDeProceso } from '../../distributor/process-config';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from '../entities/maintenance-task.entity';
import { VehicleUsageLog } from '../entities/vehicle-usage-log.entity';
import {
  estimarKmPorDia,
  factorDeEstacionalidad,
  mesDentroDe,
  MuestraDeUso,
  promedioDeFlota,
} from './domain/uso-estimado';
import {
  calcularCorreccion,
  CorreccionDeVencimiento,
} from './domain/autocalibracion';
import {
  proyectarVencimiento,
  ProyeccionDeVencimiento,
} from './domain/proyeccion-de-vencimiento';

/** Días de registro de uso que se leen: un año para ver la estacionalidad y un poco más. */
const DIAS_DE_HISTORIAL = 400;

/** Debajo de este ritmo (km por día de calendario) el propio no es creíble para proyectar. */
export const PISO_KM_POR_DIA = 5;
/** Una proyección por kilometraje más lejana que esto no se muestra ni se guarda. */
export const HORIZONTE_DIAS = 730;

export type FuenteDelConsumo = 'own' | 'fleet_average';

/** El consumo diario de un vehículo y de dónde sale. */
export interface ConsumoDelVehiculo {
  kmPorDia: number;
  /** `own`: su propio registro de uso. `fleet_average`: promedio de los vehículos del mismo tipo. */
  source: FuenteDelConsumo;
  /** Días con registro que explican la estimación propia (0 si es el promedio de la flota). */
  diasDeHistorial: number;
  /** El último día con registro de uso del vehículo, si tiene. */
  ultimoDia: string | null;
  /** El último registro es más viejo que `usageStaleDays`: no se proyecta con este consumo. */
  desactualizado: boolean;
  muestras: MuestraDeUso[];
}

/** Clave de la corrección de un vehículo y tipo de tarea (el plan). */
export const claveDeCalibracion = (carId: string, planId: string): string =>
  `${carId}:${planId}`;

/** Una tarea con su vencimiento proyectado. */
export interface TareaProyectada {
  task: MaintenanceTask;
  proyeccion: ProyeccionDeVencimiento;
  consumo: ConsumoDelVehiculo | null;
}

/**
 * CU-105, pasos 2 a 4: estima cuánto anda cada vehículo y proyecta cuándo
 * vence cada tarea. El consumo sale del registro de uso diario
 * (`vehicle_usage_log`); sin historial suficiente se toma el promedio de los
 * otros vehículos del mismo tipo, y sin ese tampoco no se proyecta.
 */
@Injectable()
export class MaintenanceForecastService {
  constructor(
    @InjectRepository(VehicleUsageLog)
    private readonly usage: Repository<VehicleUsageLog>,
    @InjectRepository(MaintenanceTask)
    private readonly tasks: Repository<MaintenanceTask>,
  ) {}

  /** El consumo de cada vehículo (`null` si ni el propio historial ni el promedio de su tipo alcanzan). */
  async consumos(
    distributorId: string,
    cars: readonly Car[],
    params: ValoresDeProceso,
    hoy: Date,
  ): Promise<Map<string, ConsumoDelVehiculo | null>> {
    const resultado = new Map<string, ConsumoDelVehiculo | null>();
    if (cars.length === 0) return resultado;
    const hoyDia = diaArgentino(hoy);
    const filas = await this.usage.find({
      where: {
        distributorId,
        carId: In(cars.map((c) => c.carId)),
        day: MoreThanOrEqual(sumarDias(hoyDia, -DIAS_DE_HISTORIAL)),
      },
      select: { carId: true, day: true, km: true },
    });
    const porVehiculo = new Map<string, MuestraDeUso[]>();
    for (const f of filas) {
      const lista = porVehiculo.get(f.carId) ?? [];
      lista.push({ day: f.day, km: f.km });
      porVehiculo.set(f.carId, lista);
    }

    const propios = new Map<string, ConsumoDelVehiculo>();
    const todos = new Map<string, ConsumoDelVehiculo>();
    for (const car of cars) {
      const muestras = porVehiculo.get(car.carId) ?? [];
      const estimado = estimarKmPorDia(muestras, hoyDia, {
        decay: params.decay,
        minSampleDays: params.minSampleDays,
        staleDays: params.usageStaleDays,
      });
      if (estimado) {
        const utilizable =
          !estimado.desactualizado && estimado.kmPorDia >= PISO_KM_POR_DIA;
        todos.set(car.carId, {
          kmPorDia: estimado.kmPorDia,
          source: 'own',
          diasDeHistorial: estimado.diasConDato,
          ultimoDia: estimado.ultimoDia,
          desactualizado: estimado.desactualizado,
          muestras,
        });
        if (!utilizable) continue;
        propios.set(car.carId, {
          kmPorDia: estimado.kmPorDia,
          source: 'own',
          diasDeHistorial: estimado.diasConDato,
          ultimoDia: estimado.ultimoDia,
          desactualizado: estimado.desactualizado,
          muestras,
        });
      }
    }

    for (const car of cars) {
      const propio = propios.get(car.carId);
      if (propio) {
        resultado.set(car.carId, propio);
        continue;
      }
      const delTipo = cars
        .filter((o) => o.carId !== car.carId && o.typeCar === car.typeCar)
        .flatMap((o) => {
          const p = propios.get(o.carId);
          return p && !p.desactualizado ? [p.kmPorDia] : [];
        });
      const promedio = promedioDeFlota(delTipo);
      resultado.set(
        car.carId,
        promedio === null
          ? // Sin promedio de su tipo: el uso viejo se informa (el panel lo marca y no se proyecta);
            // un ritmo reciente debajo del piso no es creíble y queda sin dato.
            todos.get(car.carId)?.desactualizado
            ? (todos.get(car.carId) ?? null)
            : null
          : {
              kmPorDia: promedio,
              source: 'fleet_average',
              diasDeHistorial: 0,
              ultimoDia: todos.get(car.carId)?.ultimoDia ?? null,
              desactualizado: false,
              muestras: porVehiculo.get(car.carId) ?? [],
            },
      );
    }
    return resultado;
  }

  /**
   * La corrección por el desvío histórico de cada vehículo y tipo de tarea
   * (el plan): se promedian los últimos `calibrationClosures` cierres de esa
   * pareja, con el tope de `calibrationMaxDays`. Sólo hay entrada si hay al
   * menos tres cierres medidos y la corrección no se apagó.
   */
  async correcciones(
    distributorId: string,
    cars: readonly Car[],
    params: ValoresDeProceso,
  ): Promise<Map<string, CorreccionDeVencimiento>> {
    const resultado = new Map<string, CorreccionDeVencimiento>();
    if (cars.length === 0 || params.calibrationMaxDays <= 0) return resultado;
    const cerradas = await this.tasks.find({
      where: {
        distributorId,
        carId: In(cars.map((c) => c.carId)),
        status: MaintenanceTaskStatus.DONE,
        forecastDeviationDays: Not(IsNull()),
      },
      select: {
        taskId: true,
        carId: true,
        planId: true,
        performedAt: true,
        forecastDeviationDays: true,
      },
      order: { performedAt: 'DESC' },
    });
    const desvios = new Map<string, number[]>();
    for (const t of cerradas) {
      if (!t.carId || t.forecastDeviationDays === null) continue;
      const clave = claveDeCalibracion(t.carId, t.planId);
      const lista = desvios.get(clave) ?? [];
      lista.push(t.forecastDeviationDays);
      desvios.set(clave, lista);
    }
    for (const [clave, lista] of desvios) {
      const correccion = calcularCorreccion(lista, {
        cierres: params.calibrationClosures,
        topeDias: params.calibrationMaxDays,
      });
      if (correccion) resultado.set(clave, correccion);
    }
    return resultado;
  }

  /**
   * Proyecta el vencimiento de una tarea de vehículo con el consumo del
   * vehículo, y con la corrección por su desvío histórico si la hay.
   */
  proyectar(
    task: MaintenanceTask,
    car: Car,
    consumo: ConsumoDelVehiculo | null,
    hoy: Date,
    correccion: CorreccionDeVencimiento | null = null,
  ): ProyeccionDeVencimiento {
    const hoyDia = diaArgentino(hoy);
    // Datos viejos no se proyectan: un vehículo parado no es uno que anda poco.
    const base = consumo && !consumo.desactualizado ? consumo.kmPorDia : null;
    const proyectar = (kmPorDia: number | null) => {
      const p = proyectarVencimiento({
        dueAt: task.dueAt,
        dueKm: task.dueKm,
        odometerKm: car.odometerKm,
        kmPorDia,
        hoy,
        correccion,
      });
      const lejos =
        p.porKilometraje !== null &&
        p.porKilometraje.getTime() - hoy.getTime() >
          HORIZONTE_DIAS * 86_400_000;
      if (!lejos) return p;
      return {
        ...p,
        porKilometraje: null,
        porKilometrajeSinCorregir: null,
        correccion: null,
        fecha: task.dueAt,
        enObservacion: task.dueAt === null && task.dueKm !== null,
      };
    };
    const primera = proyectar(base);
    if (!consumo || base === null || !primera.porKilometraje) return primera;

    // Segunda pasada: el consumo del mes en que cae la fecha estimada.
    const dias = Math.max(
      0,
      Math.round(
        (primera.porKilometraje.getTime() - hoy.getTime()) / 86_400_000,
      ),
    );
    const factor = factorDeEstacionalidad(
      consumo.muestras,
      mesDentroDe(hoyDia, dias),
    );
    return factor === 1 ? primera : proyectar(base * factor);
  }

  /**
   * Guarda `predicted_due_at` de las tareas abiertas cuya proyección cambió
   * (por más de un día): una tarea que no se movió no se vuelve a escribir.
   */
  async guardarPredicciones(
    proyectadas: readonly TareaProyectada[],
    ahora: Date = new Date(),
  ): Promise<number> {
    let cambiadas = 0;
    for (const { task, proyeccion } of proyectadas) {
      const nueva = proyeccion.porKilometraje ?? null;
      const actual = task.predictedDueAt;
      const igual =
        nueva === null
          ? actual === null
          : actual !== null &&
            Math.abs(nueva.getTime() - actual.getTime()) < 86_400_000;
      if (igual) continue;
      // La primera proyección se guarda sin corregir (es la que mide el desvío
      // real) y, aparte, ya corregida (para medir el acierto después de calibrar).
      const sinCorregir = proyeccion.porKilometrajeSinCorregir ?? nueva;
      const primera = task.firstPredictedDueAt ?? sinCorregir;
      const cambios: Partial<MaintenanceTask> = { predictedDueAt: nueva };
      if (!task.firstPredictedDueAt && primera) {
        cambios.firstPredictedDueAt = primera;
        cambios.firstCorrectedDueAt = nueva;
        // Con qué kilometraje y cuándo se pronosticó: al cierre se mide el ritmo real contra eso.
        if (task.dueKm !== null && proyeccion.kmFaltantes != null) {
          cambios.firstPredictedAt = ahora;
          cambios.firstPredictedOdometerKm =
            task.dueKm - proyeccion.kmFaltantes;
        }
      }
      await this.tasks.update({ taskId: task.taskId }, cambios);
      task.predictedDueAt = nueva;
      task.firstPredictedDueAt = primera;
      if (cambios.firstCorrectedDueAt !== undefined) {
        task.firstCorrectedDueAt = cambios.firstCorrectedDueAt;
        task.firstPredictedAt = cambios.firstPredictedAt ?? null;
        task.firstPredictedOdometerKm =
          cambios.firstPredictedOdometerKm ?? null;
      }
      cambiadas += 1;
    }
    return cambiadas;
  }
}
