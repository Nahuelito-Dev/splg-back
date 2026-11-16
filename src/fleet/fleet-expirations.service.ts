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
  FleetEmployeeExpirationsDto,
  FleetExpirationEntryDto,
  FleetExpirationsResponseDto,
  FleetVehicleExpirationsDto,
} from './dto/expirations-response.dto';
import {
  calcularEstadoDeVencimiento,
  diasHastaElVencimiento,
} from './domain/expiration-status';
import { estaInhabilitado } from './domain/fleet-lock.util';
import {
  FleetExpirationsQueryDto,
  FleetExpirationsSubject,
} from './dto/expirations-query.dto';
import { EmployeeService } from '../employee/employee.service';
import { EmployeeConPuesto } from '../employee/employee.mapper';

const ESTADOS_CERRADOS = [
  MaintenanceTaskStatus.DONE,
  MaintenanceTaskStatus.CANCELLED,
];

/**
 * CU-139 y CU-187: los vencimientos de toda la flota y del personal en una
 * pantalla. El personal incluye la licencia de conducir de los choferes (que
 * cuelga de su perfil de reparto) junto con lo que cuelga del legajo.
 */
@Injectable()
export class FleetExpirationsService {
  constructor(
    @InjectRepository(MaintenanceTask)
    private readonly tasks: Repository<MaintenanceTask>,
    private readonly employees: EmployeeService,
  ) {}

  async find(
    distributorId: string,
    query: FleetExpirationsQueryDto,
  ): Promise<FleetExpirationsResponseDto> {
    const withinDays = query.withinDays;
    const conVehiculos = query.subject !== FleetExpirationsSubject.EMPLOYEE;
    const conPersonal = query.subject !== FleetExpirationsSubject.VEHICLE;
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
      .leftJoinAndSelect('task.employee', 'employee')
      .leftJoinAndSelect('employee.position', 'position')
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
    const personal = new Map<string, FleetEmployeeExpirationsDto>();

    // La licencia de un chofer cuelga de su perfil de reparto: se la lleva a
    // su legajo (por la cuenta) para que el personal la vea junto al resto.
    const legajoPorCuenta = new Map<string, EmployeeConPuesto>();
    if (conPersonal) {
      const cuentas = abiertas
        .filter((t) => t.plan.subject === MaintenanceSubject.DRIVER)
        .flatMap((t) => (t.delivery?.userId ? [t.delivery.userId] : []));
      for (const legajo of await this.employees.findByUserIds(
        [...new Set(cuentas)],
        distributorId,
      )) {
        if (legajo.userId) legajoPorCuenta.set(legajo.userId, legajo);
      }
    }

    for (const task of abiertas) {
      const entry = this.aEntry(task);
      if (!entry) continue; // no debería pasar: due_at IS NOT NULL en la query

      if (task.plan.subject === MaintenanceSubject.VEHICLE && task.car) {
        if (conVehiculos) {
          this.grupoDeVehiculo(vehiculos, task.car).items.push(entry);
        }
      } else if (task.plan.subject === MaintenanceSubject.DRIVER) {
        if (task.delivery && conVehiculos) {
          this.grupoDeChofer(choferes, task.delivery).items.push(entry);
        }
        const legajo = task.delivery?.userId
          ? legajoPorCuenta.get(task.delivery.userId)
          : undefined;
        if (legajo && conPersonal && this.enLaCategoria(legajo, query)) {
          this.grupoDeEmpleado(personal, legajo).items.push(entry);
        }
      } else if (
        task.plan.subject === MaintenanceSubject.EMPLOYEE &&
        task.employee &&
        conPersonal
      ) {
        const legajo = task.employee as EmployeeConPuesto;
        if (this.enLaCategoria(legajo, query)) {
          this.grupoDeEmpleado(personal, legajo).items.push(entry);
        }
      }
    }

    for (const v of vehiculos.values()) v.isLocked = estaInhabilitado(v.items);
    for (const d of choferes.values()) d.isLocked = estaInhabilitado(d.items);
    for (const e of personal.values()) {
      e.items.sort(
        (a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0),
      );
      e.isLocked = estaInhabilitado(e.items);
    }

    const respuesta = new FleetExpirationsResponseDto();
    respuesta.withinDays = withinDays;
    respuesta.vehicles = [...vehiculos.values()];
    respuesta.drivers = [...choferes.values()];
    // De la más urgente a la menos: por su vencimiento más próximo.
    respuesta.employees = [...personal.values()].sort(
      (a, b) =>
        (a.items[0]?.dueAt?.getTime() ?? 0) -
        (b.items[0]?.dueAt?.getTime() ?? 0),
    );
    return respuesta;
  }

  private enLaCategoria(
    legajo: EmployeeConPuesto,
    query: FleetExpirationsQueryDto,
  ): boolean {
    return !query.category || legajo.position.category === query.category;
  }

  private grupoDeEmpleado(
    mapa: Map<string, FleetEmployeeExpirationsDto>,
    legajo: EmployeeConPuesto,
  ): FleetEmployeeExpirationsDto {
    const existente = mapa.get(legajo.employeeId);
    if (existente) return existente;

    const nuevo = new FleetEmployeeExpirationsDto();
    nuevo.employeeId = legajo.employeeId;
    nuevo.fullName = `${legajo.firstName} ${legajo.lastName}`;
    nuevo.fileNumber = legajo.fileNumber;
    nuevo.positionName = legajo.position.name;
    nuevo.category = legajo.position.category;
    nuevo.isLocked = false;
    nuevo.items = [];
    mapa.set(legajo.employeeId, nuevo);
    return nuevo;
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
