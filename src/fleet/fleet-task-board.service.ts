import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { withTransactionRetry } from '../common/utils/with-transaction-retry';
import {
  BoardColumn,
  calcularPosicion,
  columnaDe,
  estadosDeLaColumna,
  renumerar,
  resolverMovimiento,
} from './domain/task-board';
import {
  FleetTaskBoardCardDto,
  FleetTaskBoardDto,
  FleetTaskBoardQueryDto,
  MoveFleetTaskDto,
} from './dto/task-board.dto';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import {
  assertSinCambiosAjenos,
  movimientoRechazado,
  vecinaInvalida,
} from './fleet-task-board.errors';
import { FleetTaskBoardMapper } from './fleet-task-board.mapper';
import { FleetTaskBoardNotifier } from './fleet-task-board.notifier';
import { FleetTaskBoardReader } from './fleet-task-board.reader';
import { resolverTurno, turnoPedido } from './fleet-task-turno';
import { PlanningCaseCloser } from './planner/planning-case-closer.service';

/**
 * Tablero de tareas de flota (panel): el tablero filtrado y el movimiento de
 * una tarjeta entre columnas o dentro de la suya. El movimiento pasa por la
 * máquina de estados del dominio (`domain/task-board.ts`) con la fila
 * bloqueada: dos movimientos de la misma tarjeta se serializan y el segundo ve
 * el estado que dejó el primero.
 */
@Injectable()
export class FleetTaskBoardService {
  private readonly logger = new Logger(FleetTaskBoardService.name);

  constructor(
    @InjectRepository(MaintenanceTask)
    private readonly tasks: Repository<MaintenanceTask>,
    private readonly lector: FleetTaskBoardReader,
    private readonly avisos: FleetTaskBoardNotifier,
    // El planificador de taller (CU-105): el turno que se fija o se borra al mover lo sigue la ventana confirmada.
    @Optional() private readonly casos?: PlanningCaseCloser,
  ) {}

  async tablero(
    distributorId: string,
    query: FleetTaskBoardQueryDto,
  ): Promise<FleetTaskBoardDto> {
    const ahora = new Date();
    return FleetTaskBoardMapper.toBoard(
      await this.lector.tablero(distributorId, query, ahora),
      ahora,
    );
  }

  async mover(
    id: string,
    dto: MoveFleetTaskDto,
    distributorId: string,
    userId: string | null,
    expectedUpdatedAt?: Date,
  ): Promise<FleetTaskBoardCardDto> {
    if (dto.beforeId === id || dto.afterId === id) throw vecinaInvalida();
    // Sin fecha (ausente, o `null` si se coló) no hay turno: nunca borra el que está.
    const pedido = dto.scheduledAt ? turnoPedido(dto.scheduledAt) : undefined;
    let renumeradas: string[] = [];

    try {
      await withTransactionRetry(
        () =>
          this.tasks.manager.transaction(async (manager) => {
            const repo = manager.getRepository(MaintenanceTask);
            const task = await repo.findOne({
              where: { taskId: id, distributorId },
              lock: { mode: 'pessimistic_write' },
            });
            if (!task) throw new NotFoundException('Tarea no encontrada');
            assertSinCambiosAjenos(task.updatedAt, expectedUpdatedAt);
            await this.tomarElTablero(manager, distributorId);
            renumeradas = [];

            const movimiento = resolverMovimiento(
              task,
              dto.to,
              pedido !== undefined,
            );
            if (!movimiento.ok) {
              throw movimientoRechazado(
                movimiento.motivo,
                task.status === MaintenanceTaskStatus.DONE,
              );
            }

            if (movimiento.turno === 'borrar') {
              await resolverTurno(
                manager,
                this.casos,
                id,
                { tipo: 'borrar' },
                task.scheduledAt,
                userId,
              );
              task.scheduledAt = null;
            } else if (movimiento.turno === 'fijar') {
              const turno = await resolverTurno(
                manager,
                this.casos,
                id,
                pedido,
                task.scheduledAt,
                userId,
              );
              if (turno !== undefined) task.scheduledAt = turno;
            }
            if (movimiento.estado) {
              task.status = movimiento.estado as MaintenanceTaskStatus;
            }

            const posicion = await this.posicion(
              manager,
              distributorId,
              columnaDe(task) as BoardColumn,
              id,
              dto,
            );
            task.boardPosition = posicion.posicion;
            renumeradas = posicion.renumeradas;
            await repo.save(task);
          }),
        { context: 'tablero de flota' },
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'tareas de flota');
    }

    await this.avisos.avisar(distributorId, id, 'moved');
    if (renumeradas.length > 0) {
      await this.avisos.avisarVarias(distributorId, renumeradas, 'reordered');
    }
    const tarjeta = await this.lector.tarjeta(id, distributorId);
    if (!tarjeta) throw new NotFoundException('Tarea no encontrada');
    return FleetTaskBoardMapper.toCard(tarjeta);
  }

  /**
   * El cerrojo de las posiciones del tablero de la empresa, hasta el fin de la
   * transacción: el mismo que toma `TRG_maintenance_task_posicion_al_final`
   * (migración `PosicionesDelTableroSerializadas`). Se toma después del lock de
   * la fila, igual que el trigger (que corre con la fila ya tomada). Además le
   * avisa al trigger que esta transacción fija la posición a mano.
   */
  private async tomarElTablero(
    manager: EntityManager,
    distributorId: string,
  ): Promise<void> {
    await manager.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('fleet-board:' || $1::uuid::text, 0)), set_config('splg.tablero_posicion', 'manual', true)`,
      [distributorId],
    );
  }

  /**
   * Dónde cae la tarjeta en la columna de destino. Las vecinas tienen que ser
   * de esa columna y de la empresa (si no, 400). Si el hueco entre las vecinas
   * se agotó, la columna se renumera una vez y se vuelve a calcular.
   */
  private async posicion(
    manager: EntityManager,
    distributorId: string,
    columna: BoardColumn,
    id: string,
    vecinas: Pick<MoveFleetTaskDto, 'afterId' | 'beforeId'>,
  ): Promise<{ posicion: number; renumeradas: string[] }> {
    let filas = await this.lector.columna(manager, distributorId, columna, id);
    for (const vecina of [vecinas.afterId, vecinas.beforeId]) {
      if (vecina && !filas.some((f) => f.id === vecina)) {
        throw vecinaInvalida();
      }
    }

    let calculo = calcularPosicion(filas, vecinas);
    let renumeradas: string[] = [];
    if (!calculo.ok && calculo.motivo === 'renumerar') {
      const repo = manager.getRepository(MaintenanceTask);
      const nuevas = renumerar(filas);
      for (const fila of nuevas) {
        // Sólo la posición: `updated_at` queda como estaba (la precondición de
        // los otros paneles sigue valiendo) y sólo si la tarjeta sigue en la columna.
        await repo.update(
          {
            taskId: fila.id,
            distributorId,
            status: In(estadosDeLaColumna(columna) as MaintenanceTaskStatus[]),
          },
          {
            boardPosition: fila.position as number,
            updatedAt: () => '"updated_at"',
          },
        );
      }
      renumeradas = nuevas.map((f) => f.id);
      filas = nuevas;
      calculo = calcularPosicion(filas, vecinas);
    }
    if (!calculo.ok) throw vecinaInvalida();
    return { posicion: calculo.posicion, renumeradas };
  }
}
