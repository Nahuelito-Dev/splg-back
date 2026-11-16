import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { errorMessage } from '../../common/errors/error-message';
import {
  EnvaseDevueltoEvent,
  EVENTO_ENVASE_DEVUELTO,
} from '../events/envase-devuelto.event';
import { CylinderRecoveryService } from './cylinder-recovery.service';

/**
 * Paso 9 de CU-108: cuando se registra el movimiento de retorno del envase, su
 * caso se cierra y el depósito queda liberado, sin esperar a la próxima corrida.
 */
@Injectable()
export class CylinderRecoveryListener {
  private readonly logger = new Logger(CylinderRecoveryListener.name);

  constructor(private readonly recovery: CylinderRecoveryService) {}

  @OnEvent(EVENTO_ENVASE_DEVUELTO, { suppressErrors: false })
  async alDevolverse(evento: EnvaseDevueltoEvent): Promise<void> {
    // La devolución ya ocurrió: si cerrar el caso falla, el proceso diario lo cierra al releer el envase
    // (abiertos, escalados y perdidos), siempre que el recupero esté encendido para la distribuidora.
    try {
      await this.recovery.cerrarPorDevolucion(
        evento.distributorId,
        evento.cylinderId,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo cerrar el caso de recupero del envase ${evento.cylinderId}: ${errorMessage(error)}`,
      );
    }
  }
}
