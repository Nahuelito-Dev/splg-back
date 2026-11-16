import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not, Repository } from 'typeorm';
import { Car } from '../../car/entities/car.entity';
import {
  diaArgentino,
  ZONA_ARGENTINA,
} from '../../common/utils/dias-argentina';
import { ValoresDeProceso } from '../../distributor/process-config';
import {
  MaintenancePlanningCase,
  PlanningCaseStatus,
} from '../entities/maintenance-planning-case.entity';
import {
  MaintenanceWindowProposal,
  WindowProposalStatus,
} from '../entities/maintenance-window-proposal.entity';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from '../entities/maintenance-task.entity';
import { DemandaPorDia, UnidadesPorDia } from './domain/ventanas-de-taller';

interface FilaDeZona {
  car_id: string;
  zone_id: string;
  n: number;
}

interface FilaDeDemanda {
  dow: number;
  n: number;
}

interface FilaDeAgendados {
  day: string;
  n: number;
}

const ESTADOS_CERRADOS = [
  MaintenanceTaskStatus.DONE,
  MaintenanceTaskStatus.CANCELLED,
];

/**
 * Lo que el planificador necesita saber de la operación para elegir una
 * ventana de taller (CU-105, pasos 5 y 6): la zona de cada vehículo, cuántos
 * hay en cada zona, qué vehículos ya están comprometidos con un taller cada
 * día y cuánta demanda de pedidos se espera. Es lectura pura.
 */
export interface ContextoDePlanificacion {
  /** Zona de cobertura de cada vehículo (donde más entregó en los últimos días); sin entregas, ausente. */
  zonaDelVehiculo: Map<string, string>;
  /** Vehículos activos de cada zona. */
  vehiculosDeLaZona: Map<string, Set<string>>;
  /** Día `YYYY-MM-DD` → vehículos con un taller acordado ese día. */
  ocupadosPorDia: Map<string, Set<string>>;
  /** Demanda esperada de una zona (o de toda la distribuidora si `zona` es `null`) para un día. */
  demandaDe(zona: string | null): Promise<DemandaPorDia>;
  /** Unidades que quedan en la zona del vehículo cada día con el vehículo en el taller. */
  unidadesDe(carId: string): UnidadesPorDia;
}

/** Anota que `carId` tiene el taller ocupado ese día (lo ve toda la corrida que comparte el contexto). */
export function marcarOcupado(
  ocupadosPorDia: Map<string, Set<string>>,
  carId: string,
  instante: Date,
): void {
  const dia = diaArgentino(instante);
  const set = ocupadosPorDia.get(dia) ?? new Set<string>();
  set.add(carId);
  ocupadosPorDia.set(dia, set);
}

/**
 * Cuántos vehículos quedan activos en la zona de `carId` cada día con éste en
 * el taller: los de la zona menos los que ya tienen un taller ese día. Sin
 * zona, `null` (no hay restricción de cobertura).
 */
export function crearUnidadesDe(
  zonaDelVehiculo: Map<string, string>,
  vehiculosDeLaZona: Map<string, Set<string>>,
  ocupadosPorDia: Map<string, Set<string>>,
  carId: string,
): UnidadesPorDia {
  const zona = zonaDelVehiculo.get(carId);
  if (!zona) return () => null;
  const deLaZona = vehiculosDeLaZona.get(zona) ?? new Set<string>();
  return (dia) => {
    const ocupados = ocupadosPorDia.get(dia) ?? new Set<string>();
    const enTaller = new Set([...ocupados, carId]);
    return [...deLaZona].filter((id) => !enTaller.has(id)).length;
  };
}

@Injectable()
export class PlannerContextService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(MaintenanceTask)
    private readonly tasks: Repository<MaintenanceTask>,
    @InjectRepository(MaintenancePlanningCase)
    private readonly cases: Repository<MaintenancePlanningCase>,
    @InjectRepository(MaintenanceWindowProposal)
    private readonly proposals: Repository<MaintenanceWindowProposal>,
  ) {}

  async cargar(
    distributorId: string,
    cars: readonly Car[],
    params: ValoresDeProceso,
    ahora: Date,
  ): Promise<ContextoDePlanificacion> {
    const zonaDelVehiculo = await this.zonas(
      distributorId,
      cars.map((c) => c.carId),
      params.zoneLookbackDays,
      ahora,
    );
    const vehiculosDeLaZona = new Map<string, Set<string>>();
    for (const car of cars) {
      const zona = zonaDelVehiculo.get(car.carId);
      if (!zona) continue;
      const set = vehiculosDeLaZona.get(zona) ?? new Set<string>();
      set.add(car.carId);
      vehiculosDeLaZona.set(zona, set);
    }
    const ocupadosPorDia = await this.ocupados(distributorId, ahora);

    const cacheDeDemanda = new Map<string, DemandaPorDia>();
    return {
      zonaDelVehiculo,
      vehiculosDeLaZona,
      ocupadosPorDia,
      demandaDe: async (zona) => {
        const clave = zona ?? '*';
        const cacheada = cacheDeDemanda.get(clave);
        if (cacheada) return cacheada;
        const calculada = await this.demanda(
          distributorId,
          zona,
          params,
          ahora,
        );
        cacheDeDemanda.set(clave, calculada);
        return calculada;
      },
      unidadesDe: (carId) =>
        crearUnidadesDe(
          zonaDelVehiculo,
          vehiculosDeLaZona,
          ocupadosPorDia,
          carId,
        ),
    };
  }

  /** La zona de cada vehículo: aquella donde entregó más pedidos en los últimos `lookbackDays`. */
  private async zonas(
    distributorId: string,
    carIds: readonly string[],
    lookbackDays: number,
    ahora: Date,
  ): Promise<Map<string, string>> {
    const resultado = new Map<string, string>();
    if (carIds.length === 0) return resultado;
    const desde = new Date(ahora.getTime() - lookbackDays * 86_400_000);
    const filas: FilaDeZona[] = await this.dataSource.query(
      `SELECT "vehicle_car_id" AS car_id, "coverage_zone_id" AS zone_id, count(*)::int AS n
         FROM "order"
        WHERE "distributor_id" = $1
          AND "status" = 'delivered'
          AND "vehicle_car_id" = ANY($2::uuid[])
          AND "coverage_zone_id" IS NOT NULL
          AND "deliveredAt" >= $3
        GROUP BY 1, 2`,
      [distributorId, carIds, desde],
    );
    const mejor = new Map<string, FilaDeZona>();
    for (const f of filas) {
      const actual = mejor.get(f.car_id);
      if (
        !actual ||
        f.n > actual.n ||
        (f.n === actual.n && f.zone_id < actual.zone_id)
      ) {
        mejor.set(f.car_id, f);
      }
    }
    for (const [carId, f] of mejor) resultado.set(carId, f.zone_id);
    return resultado;
  }

  /**
   * Vehículos con un taller acordado cada día: tareas programadas con fecha a
   * futuro y casos con la ventana ya acordada con el chofer a la espera del admin.
   */
  private async ocupados(
    distributorId: string,
    ahora: Date,
  ): Promise<Map<string, Set<string>>> {
    const mapa = new Map<string, Set<string>>();
    const marcar = (carId: string | null, instante: Date | null) => {
      if (carId && instante) marcarOcupado(mapa, carId, instante);
    };
    const programadas = await this.tasks
      .createQueryBuilder('t')
      .select(['t.carId', 't.scheduledAt'])
      .where('t.distributor_id = :distributorId', { distributorId })
      .andWhere('t.car_id IS NOT NULL')
      .andWhere('t.scheduled_at >= :ahora', { ahora })
      .andWhere('t.status NOT IN (:...cerrados)', {
        cerrados: ESTADOS_CERRADOS,
      })
      .getMany();
    for (const t of programadas) marcar(t.carId, t.scheduledAt);
    const acordados = await this.cases.find({
      where: {
        distributorId,
        status: In([PlanningCaseStatus.AWAITING_CONFIRMATION]),
        chosenStart: Not(IsNull()),
      },
      select: { carId: true, chosenStart: true },
    });
    for (const c of acordados) marcar(c.carId, c.chosenStart);
    // La propuesta que espera al chofer también reserva el día: si no, dos
    // vehículos de una zona de dos se ofrecen el mismo día y quedan los dos en el taller.
    const pendientes = await this.proposals.find({
      where: {
        distributorId,
        status: In([WindowProposalStatus.PENDING]),
      },
      relations: { planningCase: true },
    });
    for (const p of pendientes) marcar(p.planningCase.carId, p.windowStart);
    return mapa;
  }

  /**
   * Demanda esperada por día: el promedio semanal de pedidos entregados en las
   * horas del taller en ese día de la semana (últimas `demandWeeks` semanas), más
   * los pedidos agendados para ese día que todavía no se entregaron.
   */
  private async demanda(
    distributorId: string,
    zona: string | null,
    params: ValoresDeProceso,
    ahora: Date,
  ): Promise<DemandaPorDia> {
    const desde = new Date(
      ahora.getTime() - params.demandWeeks * 7 * 86_400_000,
    );
    const porDiaDeSemana = new Map<number, number>();
    const historico: FilaDeDemanda[] = await this.dataSource.query(
      `SELECT extract(dow FROM "deliveredAt" AT TIME ZONE '${ZONA_ARGENTINA}')::int AS dow, count(*)::int AS n
         FROM "order"
        WHERE "distributor_id" = $1
          AND "status" = 'delivered'
          AND "deliveredAt" >= $2
          AND extract(hour FROM "deliveredAt" AT TIME ZONE '${ZONA_ARGENTINA}') >= $3
          AND extract(hour FROM "deliveredAt" AT TIME ZONE '${ZONA_ARGENTINA}') < $4
          AND ($5::uuid IS NULL OR "coverage_zone_id" = $5::uuid)
        GROUP BY 1`,
      [
        distributorId,
        desde,
        params.workshopStartHour,
        params.workshopEndHour,
        zona,
      ],
    );
    for (const f of historico)
      porDiaDeSemana.set(f.dow, f.n / params.demandWeeks);

    const hoy = diaArgentino(ahora);
    const agendados: FilaDeAgendados[] = await this.dataSource.query(
      `SELECT to_char("scheduled_date", 'YYYY-MM-DD') AS day, count(*)::int AS n
         FROM "order"
        WHERE "distributor_id" = $1
          AND "scheduled_date" >= $2::date
          AND "status" IN ('reserved', 'pending', 'accepted')
          AND ($3::uuid IS NULL OR "coverage_zone_id" = $3::uuid)
        GROUP BY 1`,
      [distributorId, hoy, zona],
    );
    const agendadosPorDia = new Map(agendados.map((a) => [a.day, a.n]));
    return (dia) => {
      const dow = new Date(`${dia}T12:00:00Z`).getUTCDay();
      return (porDiaDeSemana.get(dow) ?? 0) + (agendadosPorDia.get(dia) ?? 0);
    };
  }
}
