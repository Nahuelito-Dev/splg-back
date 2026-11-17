import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Brackets,
  EntityManager,
  In,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { normalizarFechaCalendario } from './domain/fleet-lock.util';
import { BoardColumn, columnaDe, Ubicada } from './domain/task-board';
import { MaintenanceDocumentKind } from './entities/maintenance-plan.entity';
import { MaintenanceTaskAttachment } from './entities/maintenance-task-attachment.entity';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import { FleetTaskBoardQueryDto } from './dto/task-board.dto';

/** Lo que necesita una tarjeta: la tarea (con plan, vehículo y responsable) y cuántos adjuntos tiene. */
export interface TarjetaLeida {
  task: MaintenanceTask;
  attachmentsCount: number;
}

export interface TableroLeido {
  columnas: Record<BoardColumn, TarjetaLeida[]>;
  canceladas: number;
}

/** Cuánto hacia atrás muestra la columna de hechas, si el panel no dice otra cosa. */
export const DIAS_DE_HECHAS = 30;

/**
 * La columna de cada tarea en SQL, igual que `columnaDe` del dominio y que el
 * trigger `TRG_maintenance_task_posicion_al_final`.
 */
export const SQL_COLUMNA = `(CASE WHEN task.status = 'overdue' THEN CASE WHEN task.scheduled_at IS NULL THEN 'forecast' ELSE 'scheduled' END ELSE task.status::text END)`;

const escaparLike = (texto: string) =>
  texto.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Lecturas del tablero de tareas de flota (sólo lectura, siempre acotadas a la
 * distribuidora): el tablero filtrado, una tarjeta, y las tarjetas de una
 * columna en su orden (para calcular dónde cae la que se mueve).
 */
@Injectable()
export class FleetTaskBoardReader {
  constructor(
    @InjectRepository(MaintenanceTask)
    private readonly tasks: Repository<MaintenanceTask>,
    @InjectRepository(MaintenanceTaskAttachment)
    private readonly attachments: Repository<MaintenanceTaskAttachment>,
  ) {}

  async tablero(
    distributorId: string,
    query: FleetTaskBoardQueryDto,
    ahora: Date = new Date(),
  ): Promise<TableroLeido> {
    const desde = query.doneSince
      ? new Date(query.doneSince)
      : new Date(ahora.getTime() - DIAS_DE_HECHAS * 86_400_000);

    const abiertas = this.filtrada(distributorId, query)
      .andWhere('task.status <> :cancelada', {
        cancelada: MaintenanceTaskStatus.CANCELLED,
      })
      .andWhere(
        new Brackets((w) => {
          w.where('task.status <> :hecha', {
            hecha: MaintenanceTaskStatus.DONE,
          }).orWhere('task.performed_at >= :desde', { desde });
        }),
      )
      .orderBy('task.board_position', 'ASC')
      .addOrderBy('task.due_at', 'ASC', 'NULLS LAST')
      .addOrderBy('task.task_id', 'ASC');
    const canceladas = await this.filtrada(distributorId, query)
      .andWhere('task.status = :cancelada', {
        cancelada: MaintenanceTaskStatus.CANCELLED,
      })
      .getCount();

    const tarjetas = await this.conAdjuntos(await abiertas.getMany());
    const columnas: Record<BoardColumn, TarjetaLeida[]> = {
      [BoardColumn.FORECAST]: [],
      [BoardColumn.SCHEDULED]: [],
      [BoardColumn.IN_PROGRESS]: [],
      [BoardColumn.DONE]: [],
    };
    for (const t of tarjetas) {
      const columna = columnaDe(t.task);
      if (columna) columnas[columna].push(t);
    }
    // Las hechas no se reordenan a mano: la más reciente arriba.
    columnas[BoardColumn.DONE].sort(
      (a, b) =>
        (b.task.performedAt?.getTime() ?? 0) -
        (a.task.performedAt?.getTime() ?? 0),
    );
    return { columnas, canceladas };
  }

  /** Una tarjeta de la distribuidora (también hecha o cancelada), o `null`. */
  async tarjeta(
    id: string,
    distributorId: string,
  ): Promise<TarjetaLeida | null> {
    const task = await this.base(distributorId)
      .andWhere('task.task_id = :id', { id })
      .getOne();
    if (!task) return null;
    const [tarjeta] = await this.conAdjuntos([task]);
    return tarjeta;
  }

  /** Varias tarjetas de la distribuidora, en el orden de `ids` (las que no existen se omiten). */
  async tarjetas(
    ids: readonly string[],
    distributorId: string,
  ): Promise<TarjetaLeida[]> {
    if (ids.length === 0) return [];
    const filas = await this.base(distributorId)
      .andWhere('task.task_id IN (:...ids)', { ids })
      .getMany();
    const porId = new Map(filas.map((t) => [t.taskId, t]));
    return this.conAdjuntos(
      ids.flatMap((id) => {
        const t = porId.get(id);
        return t ? [t] : [];
      }),
    );
  }

  /**
   * Las tarjetas abiertas de una columna en el orden del tablero, sin `excluir`
   * (la que se está moviendo). Dentro de la transacción de quien mueve.
   */
  async columna(
    manager: EntityManager,
    distributorId: string,
    columna: BoardColumn,
    excluir: string,
  ): Promise<Ubicada[]> {
    const filas = await manager
      .getRepository(MaintenanceTask)
      .createQueryBuilder('task')
      .select(['task.taskId', 'task.boardPosition'])
      .where('task.distributor_id = :distributorId', { distributorId })
      .andWhere(`${SQL_COLUMNA} = :columna`, { columna })
      .andWhere('task.task_id <> :excluir', { excluir })
      .orderBy('task.board_position', 'ASC')
      .addOrderBy('task.due_at', 'ASC', 'NULLS LAST')
      .addOrderBy('task.task_id', 'ASC')
      .getMany();
    return filas.map((t) => ({ id: t.taskId, position: t.boardPosition }));
  }

  private base(distributorId: string): SelectQueryBuilder<MaintenanceTask> {
    return this.tasks
      .createQueryBuilder('task')
      .innerJoinAndSelect('task.plan', 'plan')
      .leftJoinAndSelect('task.car', 'car')
      .leftJoinAndSelect('task.assignee', 'assignee')
      .where('task.distributor_id = :distributorId', { distributorId });
  }

  private filtrada(
    distributorId: string,
    query: FleetTaskBoardQueryDto,
  ): SelectQueryBuilder<MaintenanceTask> {
    const qb = this.base(distributorId);
    if (query.carId) {
      qb.andWhere('task.car_id = :carId', { carId: query.carId });
    }
    if (query.category) {
      qb.andWhere(
        query.category === MaintenanceDocumentKind.GENERIC
          ? '(plan.document_kind = :tipo OR plan.document_kind IS NULL)'
          : 'plan.document_kind = :tipo',
        { tipo: query.category },
      );
    }
    if (query.employeeId) {
      qb.andWhere(
        '(task.assignee_employee_id = :empleado OR task.employee_id = :empleado)',
        { empleado: query.employeeId },
      );
    }
    if (query.dueBefore) {
      qb.andWhere('task.due_at <= :hasta', {
        hasta: normalizarFechaCalendario(new Date(query.dueBefore)),
      });
    }
    if (query.q) {
      qb.andWhere(
        new Brackets((w) => {
          for (const campo of [
            'plan.name',
            'car.car_patent',
            'car.car_brand',
            'car.car_model',
            'assignee.first_name',
            'assignee.last_name',
            'task.provider',
            'task.reference_number',
            'task.notes',
          ]) {
            w.orWhere(`${campo} ILIKE :q`);
          }
        }),
        { q: `%${escaparLike(query.q)}%` },
      );
    }
    return qb;
  }

  private async conAdjuntos(
    tareas: MaintenanceTask[],
  ): Promise<TarjetaLeida[]> {
    if (tareas.length === 0) return [];
    const filas = await this.attachments
      .createQueryBuilder('a')
      .select('a.task_id', 'taskId')
      .addSelect('COUNT(*)::int', 'n')
      .where({ taskId: In(tareas.map((t) => t.taskId)) })
      .groupBy('a.task_id')
      .getRawMany<{ taskId: string; n: number }>();
    const cuenta = new Map(filas.map((f) => [f.taskId, Number(f.n)]));
    return tareas.map((task) => ({
      task,
      attachmentsCount: cuenta.get(task.taskId) ?? 0,
    }));
  }
}
