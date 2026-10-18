import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import {
  MaintenanceCriticality,
  MaintenancePlan,
  MaintenanceSubject,
} from './entities/maintenance-plan.entity';
import { aplicaALaCategoria } from './fleet-task.service';
import {
  calcularEstadoDeVencimiento,
  ExpirationStatus,
} from './domain/expiration-status';
import { EmployeeService } from '../employee/employee.service';
import { EmployeeConPuesto } from '../employee/employee.mapper';
import { DeliveryService } from '../delivery/delivery.service';
import { LeaveService } from '../leave/leave.service';
import { EmployeeStatus } from '../employee/entities/employee.entity';
import {
  MOTIVO_DE_LICENCIA,
  MOTIVO_LEGAJO_EGRESADO,
} from './fleet-dispatch-lock.service';
import {
  describirVencimiento,
  tareasQueInhabilitan,
} from './domain/fleet-lock.util';
import { diaArgentino } from '../common/utils/dias-argentina';
import { JobPositionCategory } from '../employee/entities/job-position.entity';

const ESTADOS_CERRADOS = [
  MaintenanceTaskStatus.DONE,
  MaintenanceTaskStatus.CANCELLED,
];

export interface DocumentacionDelEmpleado {
  empleado: EmployeeConPuesto;
  tasks: MaintenanceTask[];
  isLocked: boolean;
  /** Por qué queda inhabilitado, con la MISMA regla del despacho (CU-246) salvo el vehículo. */
  lockReasons: string[];
  missingPlans: MaintenancePlan[];
}

/**
 * La documentación del personal desde el lado del empleado (CU-187): sus
 * tarjetas (las tareas que tiene) y los planes que le faltan cargar. Las
 * tareas son las que cuelgan de su legajo más la licencia de conducir, que
 * cuelga de su perfil de reparto. También alimenta el aviso diario (CU-188).
 */
@Injectable()
export class EmployeeDocumentsService {
  constructor(
    @InjectRepository(MaintenanceTask)
    private readonly tasks: Repository<MaintenanceTask>,
    @InjectRepository(MaintenancePlan)
    private readonly plans: Repository<MaintenancePlan>,
    private readonly employees: EmployeeService,
    private readonly deliveries: DeliveryService,
    private readonly leaves: LeaveService,
  ) {}

  /** consultarDocumentacionDelEmpleado (CU-187). 404 si el legajo no es de la distribuidora. */
  async documentsOf(
    employeeId: string,
    distributorId: string,
  ): Promise<DocumentacionDelEmpleado> {
    const empleado = await this.employees.findOne(employeeId, distributorId);
    const tareas = await this.tareasDe([empleado], distributorId);
    const abiertas = tareas.filter((t) => !ESTADOS_CERRADOS.includes(t.status));
    const planes = await this.planesActivos(distributorId);
    const faltantes = this.planesFaltantes(empleado, planes, abiertas);

    const motivos: string[] = [];
    if (empleado.status !== EmployeeStatus.ACTIVE) {
      motivos.push(MOTIVO_LEGAJO_EGRESADO);
    }
    const deLicencia = await this.leaves.empleadosDeLicenciaEn(
      [empleado.employeeId],
      diaArgentino(),
    );
    if (deLicencia.has(empleado.employeeId)) motivos.push(MOTIVO_DE_LICENCIA);
    motivos.push(
      ...tareasQueInhabilitan(
        abiertas.map((t) => ({
          task: t,
          criticality: t.plan.criticality,
          expirationStatus: calcularEstadoDeVencimiento(
            t.dueAt,
            t.plan.leadTimeDays,
          ),
        })),
      ).map((c) => describirVencimiento(c.task.plan.name, c.task.dueAt)),
    );

    return {
      empleado,
      tasks: tareas,
      isLocked: motivos.length > 0,
      lockReasons: motivos,
      missingPlans: faltantes,
    };
  }

  /**
   * Los planes bloqueantes que les faltan a los choferes activos de una
   * distribuidora (aviso diario, CU-188): por empleado, sólo si le falta
   * alguno.
   */
  async faltantesBloqueantesDeChoferes(
    distributorId: string,
  ): Promise<
    Array<{ empleado: EmployeeConPuesto; planes: MaintenancePlan[] }>
  > {
    const choferes = await this.employees.findActivos(
      distributorId,
      JobPositionCategory.DRIVER,
    );
    if (choferes.length === 0) return [];

    const planes = (await this.planesActivos(distributorId)).filter(
      (p) => p.criticality === MaintenanceCriticality.BLOCKING,
    );
    if (planes.length === 0) return [];

    const abiertas = (await this.tareasDe(choferes, distributorId)).filter(
      (t) => !ESTADOS_CERRADOS.includes(t.status),
    );
    const resultado: Array<{
      empleado: EmployeeConPuesto;
      planes: MaintenancePlan[];
    }> = [];
    for (const empleado of choferes) {
      const delEmpleado = abiertas.filter(
        (t) =>
          t.employeeId === empleado.employeeId ||
          this.esSuyaPorPerfil(t, empleado),
      );
      const faltan = this.planesFaltantes(empleado, planes, delEmpleado);
      if (faltan.length > 0) resultado.push({ empleado, planes: faltan });
    }
    return resultado;
  }

  /**
   * Cuántas tareas abiertas con fecha límite hay por estado de vencimiento
   * (tablero de personal, CU-194): las de los empleados activos y la licencia
   * de los choferes.
   */
  async contarPorEstadoDeVencimiento(
    distributorId: string,
  ): Promise<Record<ExpirationStatus, number>> {
    const abiertas = await this.tasks
      .createQueryBuilder('task')
      .innerJoinAndSelect('task.plan', 'plan')
      .leftJoin('task.employee', 'employee')
      .leftJoin('task.delivery', 'delivery')
      .where('task.distributor_id = :distributorId', { distributorId })
      .andWhere('task.status NOT IN (:...cerrados)', {
        cerrados: ESTADOS_CERRADOS,
      })
      .andWhere('task.due_at IS NOT NULL')
      .andWhere(
        new Brackets((qb) => {
          qb.where(
            `plan.subject = :empleado AND employee.employee_id IS NOT NULL AND employee.status = 'active'`,
            { empleado: MaintenanceSubject.EMPLOYEE },
          ).orWhere(
            'plan.subject = :chofer AND delivery.delivery_id IS NOT NULL',
            { chofer: MaintenanceSubject.DRIVER },
          );
        }),
      )
      .getMany();

    const cuenta: Record<ExpirationStatus, number> = {
      [ExpirationStatus.CURRENT]: 0,
      [ExpirationStatus.DUE_SOON]: 0,
      [ExpirationStatus.EXPIRED]: 0,
    };
    for (const t of abiertas) {
      const estado = calcularEstadoDeVencimiento(t.dueAt, t.plan.leadTimeDays);
      if (estado) cuenta[estado]++;
    }
    return cuenta;
  }

  // ---------------------------------------------------------------------------

  private async planesActivos(
    distributorId: string,
  ): Promise<MaintenancePlan[]> {
    return this.plans.find({
      where: {
        distributorId,
        isActive: true,
        subject: In([MaintenanceSubject.EMPLOYEE, MaintenanceSubject.DRIVER]),
      },
      order: { name: 'ASC' },
    });
  }

  private planesFaltantes(
    empleado: EmployeeConPuesto,
    planes: MaintenancePlan[],
    abiertasDelEmpleado: MaintenanceTask[],
  ): MaintenancePlan[] {
    const conTarea = new Set(abiertasDelEmpleado.map((t) => t.planId));
    return planes.filter(
      (p) =>
        aplicaALaCategoria(p, empleado.position.category) &&
        !conTarea.has(p.planId),
    );
  }

  private esSuyaPorPerfil(
    tarea: MaintenanceTask,
    empleado: EmployeeConPuesto,
  ): boolean {
    if (!tarea.deliveryId || !empleado.userId) return false;
    return tarea.delivery?.userId === empleado.userId;
  }

  /**
   * Todas las tareas (abiertas y cerradas) de esos legajos: las que cuelgan
   * del legajo y, para los que tienen perfil de reparto, las de su perfil.
   */
  private async tareasDe(
    empleados: EmployeeConPuesto[],
    distributorId: string,
  ): Promise<MaintenanceTask[]> {
    if (empleados.length === 0) return [];
    const ids = empleados.map((e) => e.employeeId);
    const cuentas = empleados.flatMap((e) => (e.userId ? [e.userId] : []));
    const perfiles = await this.deliveries.findDeliveryIdsByUserIds(
      cuentas,
      distributorId,
    );
    const deliveryIds = perfiles.map((p) => p.deliveryId);

    const consulta = this.tasks
      .createQueryBuilder('task')
      .innerJoinAndSelect('task.plan', 'plan')
      .leftJoinAndSelect('task.delivery', 'delivery')
      .where('task.distributor_id = :distributorId', { distributorId })
      .andWhere(
        new Brackets((qb) => {
          qb.where('task.employee_id IN (:...ids)', { ids });
          if (deliveryIds.length > 0) {
            qb.orWhere('task.delivery_id IN (:...deliveryIds)', {
              deliveryIds,
            });
          }
        }),
      );
    return consulta
      .orderBy('task.due_at', 'ASC', 'NULLS LAST')
      .addOrderBy('task.task_id', 'ASC')
      .getMany();
  }
}
