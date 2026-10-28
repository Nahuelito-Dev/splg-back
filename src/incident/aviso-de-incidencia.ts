import type { Logger } from '@nestjs/common';
import type { AdminGateway } from '../gateways/admin.gateway';
import { errorMessage } from '../common/errors/error-message';
import type { Incident } from './entities/incident.entity';

/** Evento del panel con cada incidencia nueva (también las de cobro impago). */
export const EVENTO_INCIDENCIA_CREADA = 'incident:created';

/** Avisa a los admins de la distribuidora. Best-effort: la incidencia ya está guardada. */
export function avisarIncidenciaAAdmins(
  gateway: AdminGateway,
  incident: Incident,
  logger: Logger,
): void {
  try {
    gateway.notifyAdmins(
      EVENTO_INCIDENCIA_CREADA,
      {
        incidentId: incident.incidentId,
        orderId: incident.orderId,
        distributorId: incident.distributorId,
        type: incident.type,
        description: incident.description,
        createdAt: incident.createdAt,
      },
      incident.distributorId,
    );
  } catch (error) {
    logger.warn(
      `No se pudo avisar a los admins de la incidencia ${incident.incidentId}: ${errorMessage(error)}`,
    );
  }
}
