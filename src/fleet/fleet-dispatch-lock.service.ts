import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Not, Repository } from 'typeorm';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import { VehicleAssignmentService } from '../car/vehicle-assignment.service';
import { DeliveryService } from '../delivery/delivery.service';
import {
  describirVencimiento,
  tareasQueInhabilitan,
  HabilitacionRelevante,
} from './domain/fleet-lock.util';
import { calcularEstadoDeVencimiento } from './domain/expiration-status';

const ESTADOS_CERRADOS = [
  MaintenanceTaskStatus.DONE,
  MaintenanceTaskStatus.CANCELLED,
];

/** Sin fecha ni chofer: el motivo "no tiene un vehículo asignado" no viene de ninguna tarea. */
const MOTIVO_SIN_VEHICULO = 'no tiene un vehículo asignado';

/** Una tarea abierta junto con su estado de vencimiento, para filtrarla con `tareasQueInhabilitan`. */
interface TareaConEstado extends HabilitacionRelevante {
  task: MaintenanceTask;
}

/** Snapshot del vehículo en uso de un chofer, para guardar en el pedido al aceptarlo. */
export interface VehiculoEnUsoSnapshot {
  carId: string;
  patent: string | null;
  brand: string | null;
  model: string | null;
}

/** Lo que `tareasInhabilitantesPorChofer` necesita devolver a sus dos callers públicos. */
interface InhabilitacionesPorChofer {
  /** `user_id` → tareas (licencia propia y/o del vehículo en uso) que inhabilitan. */
  porTarea: Map<string, MaintenanceTask[]>;
  /** `user_id` de los que no tienen NINGÚN vehículo en uso (inhabilita igual, sin tarea de por medio). */
  sinVehiculo: Set<string>;
}

/**
 * El gate único de bloqueo de flota para el despacho (CU-136 a CU-138, más
 * la decisión de nahue del 30/09 de "vehículo en uso"): un chofer con la
 * licencia vencida, sin un vehículo asignado, o cuyo vehículo EN USO tenga
 * el seguro/VTV vencidos, no recibe ofertas ni puede asignarse a un pedido.
 * Ya no importa qué otros autos tenga a su nombre (`car.user_id`): sólo el
 * que está usando de verdad (punto 5 de la revisión anterior, resuelto).
 *
 * Lo usan los TRES caminos que le dan un pedido a un chofer, con la MISMA
 * regla (nunca duplicada):
 * - `OrderService.assignDelivery` (asignación manual del admin) y
 *   `UpdateOrderStatusUseCase` (`PATCH /orders/:id/status` con
 *   `status=accepted`, admin con `deliveryId` o el propio chofer desde el
 *   pool) llaman a `assertChoferHabilitado`: si algo está vencido, 400 con
 *   el detalle. Los dos también llaman a `vehiculoEnUsoDelChofer` para
 *   guardar el snapshot del vehículo en el pedido.
 * - `DispatchOrchestratorService` (despacho automático) llama a
 *   `choferesInhabilitados` para filtrar, en lote, la lista de candidatos
 *   de cada intento de oferta.
 *
 * Extraído de `FleetTaskService` (que sólo expone las fachadas de sólo
 * lectura `/cars/:id/documents` y `/delivery/:id/documents`) para no mezclar
 * dos responsabilidades en un mismo servicio.
 */
@Injectable()
export class FleetDispatchLockService {
  constructor(
    @InjectRepository(MaintenanceTask)
    private readonly tasks: Repository<MaintenanceTask>,
    private readonly vehicleAssignments: VehicleAssignmentService,
    private readonly deliveryService: DeliveryService,
  ) {}

  /**
   * Despacho (CU-012/CU-013/CU-016): de esos choferes (`user_id`, el mismo
   * que usan el radar y las ofertas), cuáles están INHABILITADOS — por su
   * propia licencia (CU-138), por no tener un vehículo en uso, o por el
   * vehículo que tienen en uso (CU-136/137). Una sola consulta en lote
   * (`tareasInhabilitantesPorChofer`): nada de un round-trip por candidato
   * del radio de búsqueda.
   */
  async choferesInhabilitados(
    driverUserIds: string[],
    distributorId?: string | null,
  ): Promise<Set<string>> {
    const { porTarea, sinVehiculo } = await this.tareasInhabilitantesPorChofer(
      driverUserIds,
      distributorId,
    );
    return new Set([...porTarea.keys(), ...sinVehiculo]);
  }

  /**
   * Qué está vencido en el chofer, en castellano y con fecha (o que no
   * tiene vehículo asignado). Vacío si el chofer está en condiciones. Lo
   * usa `assertChoferHabilitado` (abajo) para armar el 400; expuesto
   * también por si algún caller sólo necesita el detalle sin que se le
   * corte el flujo con una excepción.
   */
  async motivosDeInhabilitacion(
    driverUserId: string,
    distributorId?: string | null,
  ): Promise<string[]> {
    const { porTarea, sinVehiculo } = await this.tareasInhabilitantesPorChofer(
      [driverUserId],
      distributorId,
    );
    const motivos = (porTarea.get(driverUserId) ?? []).map((t) =>
      describirVencimiento(t.plan.name, t.dueAt),
    );
    if (sinVehiculo.has(driverUserId)) {
      motivos.push(MOTIVO_SIN_VEHICULO);
    }
    return motivos;
  }

  /**
   * El gate único de asignación de flota. Lo llaman los tres caminos que le
   * dan un pedido a un chofer (ver el comentario de la clase): si el chofer
   * tiene algo vencido o no tiene vehículo, 400 con el detalle en
   * castellano; si no, no hace nada.
   */
  async assertChoferHabilitado(
    driverUserId: string,
    distributorId?: string | null,
  ): Promise<void> {
    const motivos = await this.motivosDeInhabilitacion(
      driverUserId,
      distributorId,
    );
    if (motivos.length > 0) {
      throw new BadRequestException(
        `No se puede asignar: ${motivos.join('; ')}.`,
      );
    }
  }

  /**
   * El vehículo en uso del chofer (marca, modelo, patente), o `null` si no
   * tiene. Lo llaman `OrderService.assignDelivery` y
   * `UpdateOrderStatusUseCase` DESPUÉS de `assertChoferHabilitado`, para
   * guardar el snapshot en el pedido — a esa altura el chofer ya pasó el
   * gate, así que si tiene vehículo, éste no viene inhabilitado.
   */
  async vehiculoEnUsoDelChofer(
    driverUserId: string,
    distributorId?: string | null,
  ): Promise<VehiculoEnUsoSnapshot | null> {
    const [delivery] = await this.deliveryService.findDeliveryIdsByUserIds(
      [driverUserId],
      distributorId,
    );
    if (!delivery) return null;

    const [vehiculo] =
      await this.vehicleAssignments.findVehiculosEnUsoPorDeliveryIds(
        [delivery.deliveryId],
        distributorId,
      );
    if (!vehiculo) return null;

    return {
      carId: vehiculo.carId,
      patent: vehiculo.patent,
      brand: vehiculo.brand,
      model: vehiculo.model,
    };
  }

  /**
   * El corazón de las anteriores: para cada chofer (`user_id`), las tareas
   * ABIERTAS que lo inhabilitan (las propias de su licencia, o las del
   * vehículo que tiene EN USO) y quiénes no tienen ningún vehículo en uso.
   * Tres consultas en total, sin importar cuántos choferes se pidan: las
   * deliveries, los vehículos en uso, y las tareas abiertas de todos esos
   * sujetos a la vez.
   */
  private async tareasInhabilitantesPorChofer(
    driverUserIds: string[],
    distributorId?: string | null,
  ): Promise<InhabilitacionesPorChofer> {
    const porTarea = new Map<string, MaintenanceTask[]>();
    const sinVehiculo = new Set<string>();
    if (driverUserIds.length === 0) return { porTarea, sinVehiculo };

    const deliveries = await this.deliveryService.findDeliveryIdsByUserIds(
      driverUserIds,
      distributorId,
    );
    if (deliveries.length === 0) return { porTarea, sinVehiculo };

    const vehiculos =
      await this.vehicleAssignments.findVehiculosEnUsoPorDeliveryIds(
        deliveries.map((d) => d.deliveryId),
        distributorId,
      );
    const carIdPorDelivery = new Map(
      vehiculos.map((v) => [v.deliveryId, v.carId]),
    );

    const tareasAbiertas = await this.tareasAbiertasDe(
      deliveries.map((d) => d.deliveryId),
      vehiculos.map((v) => v.carId),
      distributorId,
    );
    const { porDelivery, porCar } = this.agruparPorSujeto(tareasAbiertas);

    for (const d of deliveries) {
      const inhabilitantesLicencia = this.filtrarInhabilitantes(
        porDelivery.get(d.deliveryId) ?? [],
      );
      const carId = carIdPorDelivery.get(d.deliveryId);

      if (!carId) {
        // Sin vehículo en uso: inhabilita por sí solo, aparte de cualquier
        // tarea de la licencia (que igual se suma si la tiene).
        sinVehiculo.add(d.userId);
        if (inhabilitantesLicencia.length > 0) {
          porTarea.set(d.userId, inhabilitantesLicencia);
        }
        continue;
      }

      const inhabilitantesVehiculo = this.filtrarInhabilitantes(
        porCar.get(carId) ?? [],
      );
      const todas = [...inhabilitantesLicencia, ...inhabilitantesVehiculo];
      if (todas.length > 0) {
        porTarea.set(d.userId, todas);
      }
    }

    return { porTarea, sinVehiculo };
  }

  /** Las tareas abiertas (no `done` ni `cancelled`) de esas deliveries y/o esos autos, en una sola consulta. */
  private async tareasAbiertasDe(
    deliveryIds: string[],
    carIds: string[],
    distributorId?: string | null,
  ): Promise<MaintenanceTask[]> {
    const filtroDeDistribuidora = distributorId ? { distributorId } : {};
    const condiciones: FindOptionsWhere<MaintenanceTask>[] = [];
    if (deliveryIds.length > 0) {
      condiciones.push({
        deliveryId: In(deliveryIds),
        status: Not(In(ESTADOS_CERRADOS)),
        ...filtroDeDistribuidora,
      });
    }
    if (carIds.length > 0) {
      condiciones.push({
        carId: In(carIds),
        status: Not(In(ESTADOS_CERRADOS)),
        ...filtroDeDistribuidora,
      });
    }
    if (condiciones.length === 0) return [];

    return this.tasks.find({ where: condiciones, relations: ['plan'] });
  }

  /** Agrupa tareas por `delivery_id` y por `car_id` (una tarea sólo tiene uno de los dos, nunca los dos). */
  private agruparPorSujeto(tareas: MaintenanceTask[]): {
    porDelivery: Map<string, MaintenanceTask[]>;
    porCar: Map<string, MaintenanceTask[]>;
  } {
    const porDelivery = new Map<string, MaintenanceTask[]>();
    const porCar = new Map<string, MaintenanceTask[]>();

    for (const task of tareas) {
      if (task.deliveryId) {
        const lista = porDelivery.get(task.deliveryId) ?? [];
        lista.push(task);
        porDelivery.set(task.deliveryId, lista);
      }
      if (task.carId) {
        const lista = porCar.get(task.carId) ?? [];
        lista.push(task);
        porCar.set(task.carId, lista);
      }
    }

    return { porDelivery, porCar };
  }

  /** De esas tareas, las que efectivamente inhabilitan (bloqueante + vencida). */
  private filtrarInhabilitantes(tareas: MaintenanceTask[]): MaintenanceTask[] {
    const conEstado: TareaConEstado[] = tareas.map((t) => ({
      task: t,
      criticality: t.plan.criticality,
      expirationStatus: calcularEstadoDeVencimiento(
        t.dueAt,
        t.plan.leadTimeDays,
      ),
    }));
    return tareasQueInhabilitan(conEstado).map((c) => c.task);
  }
}
