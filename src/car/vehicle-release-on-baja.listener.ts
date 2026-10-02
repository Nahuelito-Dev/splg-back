import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { VehicleAssignmentService } from './vehicle-assignment.service';
import {
  ChoferDadoDeBajaEvent,
  EVENTO_CHOFER_DADO_DE_BAJA,
} from '../delivery/events/chofer-dado-de-baja.event';

/**
 * Libera el vehículo en uso cuando se da de baja al chofer, dentro de la
 * transacción de la baja. Escucha el evento en vez de que `users` llame a
 * `car` directo: así `users` no depende de `car` (CONVENCIONES §4; mismo
 * patrón que `BienvenidaListener`). No suprime errores: si la liberación
 * falla, la baja se revierte.
 */
@Injectable()
export class VehicleReleaseOnBajaListener {
  constructor(private readonly vehicleAssignments: VehicleAssignmentService) {}

  @OnEvent(EVENTO_CHOFER_DADO_DE_BAJA, { suppressErrors: false })
  async handle(evento: ChoferDadoDeBajaEvent): Promise<void> {
    await this.vehicleAssignments.liberarSiTieneUno(
      evento.deliveryId,
      evento.manager,
    );
  }
}
