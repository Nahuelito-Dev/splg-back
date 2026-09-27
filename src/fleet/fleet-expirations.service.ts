import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import { MaintenanceSubject } from './entities/maintenance-plan.entity';
import {
  FleetDriverExpirationsDto,
  FleetExpirationEntryDto,
  FleetExpirationsResponseDto,
  FleetVehicleExpirationsDto,
} from './dto/expirations-response.dto';
import {
  calcularEstadoDeVencimiento,
  diasHastaElVencimiento,
} from './domain/expiration-status';
import { estaInhabilitado } from './domain/fleet-lock.util';

const ESTADOS_CERRADOS = [
  MaintenanceTaskStatus.DONE,
  MaintenanceTaskStatus.CANCELLED,
];

/** CU-139: los vencimientos de toda la flota en una pantalla. */
@Injectable()
export class FleetExpirationsService {
  constructor(
    @InjectRepository(MaintenanceTask)
    private readonly tasks: Repository<MaintenanceTask>,
  ) {}

  async find(
    distributorId: string,
    withinDays: number,
  ): Promise<FleetExpirationsResponseDto> {
    const limite = new Date();
    limite.setDate(limite.getDate() + withinDays);

    // Vencidas y por vencer: cualquier tarea vencida cumple `due_at <= limite`
    // sin importar `withinDays` (limite siempre es >= ahora), así que no hace
    // falta una condición aparte para "lo vencido".
    const abiertas = await this.tasks
      .createQueryBuilder('task')
      .innerJoinAndSelect('task.plan', 'plan')
      .leftJoinAndSelect('task.car', 'car')
      .leftJoinAndSelect('task.delivery', 'delivery')
      .leftJoinAndSelect('delivery.user', 'deliveryUser')
      .where('task.distributor_id = :distributorId', { distributorId })
      .andWhere('task.status NOT IN (:...cerrados)', {
        cerrados: ESTADOS_CERRADOS,
      })
      .andWhere('task.due_at IS NOT NULL')
      .andWhere('task.due_at <= :limite', { limite })
      .orderBy('task.due_at', 'ASC')
      .getMany();

    const vehiculos = new Map<string, FleetVehicleExpirationsDto>();
    const choferes = new Map<string, FleetDriverExpirationsDto>();

    for (const task of abiertas) {
      const entry = this.aEntry(task);
      if (!entry) continue; // no debería pasar: due_at IS NOT NULL en la query

      if (task.plan.subject === MaintenanceSubject.VEHICLE && task.car) {
        this.grupoDeVehiculo(vehiculos, task.car).items.push(entry);
      } else if (
        task.plan.subject === MaintenanceSubject.DRIVER &&
        task.delivery
      ) {
        this.grupoDeChofer(choferes, task.delivery).items.push(entry);
      }
    }

    for (const v of vehiculos.values()) v.isLocked = estaInhabilitado(v.items);
    for (const d of choferes.values()) d.isLocked = estaInhabilitado(d.items);

    const respuesta = new FleetExpirationsResponseDto();
    respuesta.withinDays = withinDays;
    respuesta.vehicles = [...vehiculos.values()];
    respuesta.drivers = [...choferes.values()];
    return respuesta;
  }

  private aEntry(task: MaintenanceTask): FleetExpirationEntryDto | null {
    const expirationStatus = calcularEstadoDeVencimiento(
      task.dueAt,
      task.plan.leadTimeDays,
    );
    if (expirationStatus === null) return null;

    const dto = new FleetExpirationEntryDto();
    dto.taskId = task.taskId;
    dto.planId = task.planId;
    dto.planName = task.plan.name;
    dto.criticality = task.plan.criticality;
    dto.dueAt = task.dueAt;
    dto.expirationStatus = expirationStatus;
    dto.daysUntilDue = diasHastaElVencimiento(task.dueAt);
    return dto;
  }

  private grupoDeVehiculo(
    mapa: Map<string, FleetVehicleExpirationsDto>,
    car: NonNullable<MaintenanceTask['car']>,
  ): FleetVehicleExpirationsDto {
    const existente = mapa.get(car.carId);
    if (existente) return existente;

    const nuevo = new FleetVehicleExpirationsDto();
    nuevo.carId = car.carId;
    nuevo.carPatent = car.carPatent;
    nuevo.carBrand = car.carBrand;
    nuevo.carModel = car.carModel;
    nuevo.isLocked = false;
    nuevo.items = [];
    mapa.set(car.carId, nuevo);
    return nuevo;
  }

  private grupoDeChofer(
    mapa: Map<string, FleetDriverExpirationsDto>,
    delivery: NonNullable<MaintenanceTask['delivery']>,
  ): FleetDriverExpirationsDto {
    const existente = mapa.get(delivery.deliveryId);
    if (existente) return existente;

    const nuevo = new FleetDriverExpirationsDto();
    nuevo.deliveryId = delivery.deliveryId;
    nuevo.userId = delivery.userId;
    nuevo.fullName = delivery.user?.fullName ?? null;
    nuevo.isLocked = false;
    nuevo.items = [];
    mapa.set(delivery.deliveryId, nuevo);
    return nuevo;
  }
}
