import { Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '../../common/errors/error-message';
import { AdminGateway } from '../../gateways/admin.gateway';
import type { SupportSession } from '../entities/support-session.entity';

/**
 * Avisa por el socket del panel (`support:ended`, sala personal del super admin)
 * que su sesión de soporte terminó, para que salga del modo al instante. Es
 * best-effort: el guard ya responde 403 en la request siguiente y el panel
 * consulta `current` cada 30 s.
 */
@Injectable()
export class SupportEndedNotice {
  private readonly logger = new Logger(SupportEndedNotice.name);

  constructor(private readonly gateway: AdminGateway) {}

  avisar(
    sesion: Pick<
      SupportSession,
      'supportSessionId' | 'requestedBy' | 'status' | 'endReason'
    >,
  ): void {
    try {
      this.gateway.avisarFinDeSoporte(sesion.requestedBy, {
        sessionId: sesion.supportSessionId,
        status: sesion.status,
        endReason: sesion.endReason,
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo avisar el fin de la sesión de soporte ${sesion.supportSessionId}: ${errorMessage(error)}`,
      );
    }
  }
}
