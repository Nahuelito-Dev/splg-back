import { Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '../common/errors/error-message';
import { AdminGateway } from '../gateways/admin.gateway';
import { FleetTaskBoardEventDto, FleetTaskChange } from './dto/task-board.dto';
import { FleetTaskBoardMapper } from './fleet-task-board.mapper';
import { FleetTaskBoardReader } from './fleet-task-board.reader';

/** Evento del socket del panel con cada cambio de una tarea de flota. */
export const EVENTO_TAREA_DE_FLOTA = 'fleet:task';

export type CambioDeTarea = `${FleetTaskChange}`;

/**
 * Avisa al tablero del panel (`fleet:task`, sala de la empresa) que una tarea
 * cambió, con la tarjeta como quedó. Se llama después de confirmar la
 * transacción: el panel nunca ve un cambio que se deshizo. Si el aviso falla,
 * la operación ya hecha no se rompe (el panel se pone al día al releer).
 */
@Injectable()
export class FleetTaskBoardNotifier {
  private readonly logger = new Logger(FleetTaskBoardNotifier.name);

  constructor(
    private readonly lector: FleetTaskBoardReader,
    private readonly gateway: AdminGateway,
  ) {}

  async avisar(
    distributorId: string,
    taskId: string,
    cambio: CambioDeTarea,
  ): Promise<void> {
    await this.avisarVarias(distributorId, [taskId], cambio);
  }

  async avisarVarias(
    distributorId: string,
    taskIds: readonly string[],
    cambio: CambioDeTarea,
  ): Promise<void> {
    try {
      const tarjetas = await this.lector.tarjetas(taskIds, distributorId);
      const ahora = new Date();
      for (const tarjeta of tarjetas) {
        const evento: FleetTaskBoardEventDto = {
          id: tarjeta.task.taskId,
          change: cambio as FleetTaskChange,
          card: FleetTaskBoardMapper.toCard(tarjeta, ahora),
        };
        this.gateway.emitirALaFlota(
          distributorId,
          EVENTO_TAREA_DE_FLOTA,
          evento,
        );
      }
    } catch (error) {
      this.logger.warn(
        `No se pudo avisar al tablero (${cambio}): ${errorMessage(error)}`,
      );
    }
  }
}
