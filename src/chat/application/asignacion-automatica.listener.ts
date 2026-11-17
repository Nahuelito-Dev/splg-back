import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConversationStatus, esCanalDeLaBandeja } from '../domain/chat.enums';
import { AsignacionAutomaticaService } from './asignacion-automatica.service';
import {
  type AjustesDeAsignacionCambiados,
  type ConversacionCambiada,
  EVENTO_AJUSTES_DE_ASIGNACION,
  EVENTO_CONVERSACION_CAMBIO,
} from './chat.events';
import { EquipoDeLaBandejaService } from './equipo-de-la-bandeja.service';

/**
 * Los disparadores del reparto (8b) que llegan por eventos, después del
 * commit de la operación que los causó:
 *
 *  - una conversación quedó esperando a una persona sin asignar (el cliente
 *    o el chofer escribió y nadie la atiende, pidió una persona o el
 *    asistente la derivó);
 *  - alguien liberó lugar: la cerró o la devolvió a la cola, o una
 *    asignación a mano se la pasó a otro;
 *  - se prendió la función o cambió el tope de la empresa.
 *
 * De paso avisa `chat:team` con la carga nueva de quien la tenía y de quien
 * la tiene. Lo que asigna el propio reparto no vuelve a dispararlo.
 */
@Injectable()
export class AsignacionAutomaticaListener {
  constructor(
    private readonly asignacion: AsignacionAutomaticaService,
    private readonly equipo: EquipoDeLaBandejaService,
  ) {}

  @OnEvent(EVENTO_CONVERSACION_CAMBIO, { async: true })
  async conversacion({
    conversation: c,
    change,
    previousAssignedToUserId,
  }: ConversacionCambiada): Promise<void> {
    if (!esCanalDeLaBandeja(c.channel) || change === 'labels') return;
    if (change === 'assigned' && c.assignedAutomatically) return;
    // Sólo el aviso `status`: es el que sale al marcar la espera. Al abrir
    // una conversación con el primer mensaje también sale `created` con el
    // mismo objeto ya marcado: así hay un solo disparo por mensaje.
    const quedoEsperando =
      change === 'status' &&
      c.status === ConversationStatus.OPEN &&
      c.assignedToUserId === null &&
      c.awaitingHumanSince !== null;
    const liberoLugar =
      change === 'closed' ||
      (change === 'assigned' && (previousAssignedToUserId ?? null) !== null);
    if (quedoEsperando || liberoLugar) {
      await this.asignacion.repartirSinFallar(c.distributorId);
    }
    const afectados = [
      c.assignedToUserId,
      previousAssignedToUserId ?? null,
    ].filter((u): u is string => u !== null);
    if (
      afectados.length > 0 &&
      (change === 'assigned' || change === 'closed' || change === 'reopened')
    ) {
      await this.equipo.avisar(c.distributorId, afectados);
    }
  }

  @OnEvent(EVENTO_AJUSTES_DE_ASIGNACION, { async: true })
  async ajustes({
    distributorId,
  }: AjustesDeAsignacionCambiados): Promise<void> {
    await this.asignacion.repartirSinFallar(distributorId);
  }
}
