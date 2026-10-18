import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import { MaintenanceDocumentKind } from './entities/maintenance-plan.entity';
import { VehicleUsageLog } from './entities/vehicle-usage-log.entity';

/** Una tarea de mantenimiento hecha, con lo que costó. */
export interface CostoDeMantenimiento {
  carId: string;
  performedAt: Date;
  cost: number;
}

/** La prima de una póliza y su vigencia (`validFrom` nulo = póliza anterior al registro de la vigencia). */
export interface CostoDeSeguro {
  carId: string;
  validFrom: Date | null;
  dueAt: Date;
  cost: number;
}

export interface KmDeUso {
  carId: string;
  km: number;
}

/**
 * Lo que `fleet` sabe del costo de los vehículos (CU-203/204): el
 * mantenimiento hecho, las pólizas con su prima y los kilómetros del registro
 * de uso. Sólo lectura: el costo total lo compone `fleet-expense` sumando
 * esto a lo suyo (combustible, multas y siniestros).
 */
@Injectable()
export class FleetCostSourceService {
  constructor(
    @InjectRepository(MaintenanceTask)
    private readonly tasks: Repository<MaintenanceTask>,
    @InjectRepository(VehicleUsageLog)
    private readonly usage: Repository<VehicleUsageLog>,
  ) {}

  /** Tareas hechas en `[desde, hasta)` con costo, sin las pólizas (se prorratean aparte). */
  async mantenimiento(
    distributorId: string,
    carIds: string[],
    desde: Date,
    hasta: Date,
  ): Promise<CostoDeMantenimiento[]> {
    if (carIds.length === 0) return [];
    const filas = await this.tasks
      .createQueryBuilder('task')
      .innerJoin('task.plan', 'plan')
      .select(['task.carId', 'task.performedAt', 'task.cost'])
      .where('task.distributor_id = :distributorId', { distributorId })
      .andWhere('task.car_id IN (:...carIds)', { carIds })
      .andWhere('task.status = :hecha', { hecha: MaintenanceTaskStatus.DONE })
      .andWhere('task.cost IS NOT NULL')
      .andWhere('task.performed_at >= :desde AND task.performed_at < :hasta', {
        desde,
        hasta,
      })
      .andWhere('plan.document_kind IS DISTINCT FROM :seguro', {
        seguro: MaintenanceDocumentKind.INSURANCE,
      })
      .getMany();
    return filas.map((t) => ({
      carId: t.carId as string,
      performedAt: t.performedAt as Date,
      cost: t.cost as number,
    }));
  }

  /** El mayor kilometraje con que se cerró una tarea hecha del vehículo, o `null` si ninguna lo tiene. */
  async kmMaximoDeTareasHechas(
    distributorId: string,
    carId: string,
  ): Promise<number | null> {
    const fila = await this.tasks
      .createQueryBuilder('task')
      .select('MAX(task.odometer_km)', 'max')
      .where('task.distributor_id = :distributorId AND task.car_id = :carId', {
        distributorId,
        carId,
      })
      .andWhere('task.status = :hecha', { hecha: MaintenanceTaskStatus.DONE })
      .getRawOne<{ max: number | null }>();
    return fila?.max ?? null;
  }

  /**
   * Pólizas con prima cuya vigencia termina en o después de `desde`. Sólo las
   * vigentes o pagadas: una póliza prevista (renovación pendiente, con un
   * importe estimado) y las canceladas no cuentan.
   */
  async seguros(
    distributorId: string,
    carIds: string[],
    desde: Date,
  ): Promise<CostoDeSeguro[]> {
    if (carIds.length === 0) return [];
    const filas = await this.tasks
      .createQueryBuilder('task')
      .innerJoin('task.plan', 'plan')
      .select(['task.carId', 'task.validFrom', 'task.dueAt', 'task.cost'])
      .where('task.distributor_id = :distributorId', { distributorId })
      .andWhere('task.car_id IN (:...carIds)', { carIds })
      .andWhere('task.status NOT IN (:...fueraDelCosto)', {
        fueraDelCosto: [
          MaintenanceTaskStatus.CANCELLED,
          MaintenanceTaskStatus.FORECAST,
        ],
      })
      .andWhere('task.cost IS NOT NULL AND task.due_at IS NOT NULL')
      .andWhere('task.due_at >= :desde', { desde })
      .andWhere('plan.document_kind = :seguro', {
        seguro: MaintenanceDocumentKind.INSURANCE,
      })
      .getMany();
    return filas.map((t) => ({
      carId: t.carId as string,
      validFrom: t.validFrom,
      dueAt: t.dueAt as Date,
      cost: t.cost as number,
    }));
  }

  /** Kilómetros del registro de uso diario entre dos días (`YYYY-MM-DD`, inclusivos). */
  async kmDeUso(
    distributorId: string,
    carIds: string[],
    desdeDia: string,
    hastaDia: string,
  ): Promise<KmDeUso[]> {
    if (carIds.length === 0) return [];
    const filas = await this.usage
      .createQueryBuilder('u')
      .select('u.car_id', 'carId')
      .addSelect('SUM(u.km)', 'km')
      .where('u.distributor_id = :distributorId', { distributorId })
      .andWhere('u.car_id IN (:...carIds)', { carIds })
      .andWhere('u.day BETWEEN :desdeDia AND :hastaDia', {
        desdeDia,
        hastaDia,
      })
      .groupBy('u.car_id')
      .getRawMany<{ carId: string; km: string }>();
    return filas.map((f) => ({ carId: f.carId, km: Number(f.km) }));
  }
}
