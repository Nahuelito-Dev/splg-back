import type { Logger } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { AdminGateway } from '../gateways/admin.gateway';
import {
  idCortoDePedido,
  pedirAvisoAlAdmin,
} from '../common/events/aviso-al-admin';
import { errorMessage } from '../common/errors/error-message';
import { IncidentType, type Incident } from './entities/incident.entity';

const MOTIVO: Readonly<Record<IncidentType, string>> = {
  [IncidentType.DAMAGED]: 'Producto dañado',
  [IncidentType.OUT_OF_STOCK]: 'Sin stock',
  [IncidentType.NO_SHOW]: 'Cliente ausente',
  [IncidentType.UNPAID_COLLECTION]: 'Cobro en efectivo impago',
  [IncidentType.OTHER]: 'Otro motivo',
};

/** Evento del panel con cada incidencia nueva (también las de cobro impago). */
export const EVENTO_INCIDENCIA_CREADA = 'incident:created';

/** Avisa a los admins de la distribuidora, en vivo y en la bandeja. Best-effort: la incidencia ya está guardada. */
export function avisarIncidenciaAAdmins(
  gateway: AdminGateway,
  incident: Incident,
  logger: Logger,
  events: EventEmitter2,
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
  pedirAvisoAlAdmin(events, logger, {
    distributorId: incident.distributorId,
    kind: 'incident_created',
    title: 'Nueva incidencia',
    body: `Pedido #${idCortoDePedido(incident.orderId)}: ${MOTIVO[incident.type]}`,
    link: { entity: 'incident', id: incident.incidentId },
    dedupeKey: `incident:${incident.incidentId}`,
  });
}
