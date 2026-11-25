import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DespachoBloqueadoEvent,
  EVENTO_DESPACHO_BLOQUEADO,
} from '../domain/events/despacho-bloqueado.event';
import {
  EnvaseDevueltoEvent,
  EVENTO_ENVASE_DEVUELTO,
} from '../domain/events/envase-devuelto.event';
import { CylinderEventsPort } from '../domain/ports/cylinder-events.port';

/** Adaptador de eventos: los publica en el bus en memoria de la aplicación. */
@Injectable()
export class CylinderEventsAdapter extends CylinderEventsPort {
  constructor(private readonly eventos: EventEmitter2) {
    super();
  }

  despachoBloqueado(evento: DespachoBloqueadoEvent): void {
    this.eventos.emit(EVENTO_DESPACHO_BLOQUEADO, evento);
  }

  envaseDevuelto(evento: EnvaseDevueltoEvent): void {
    this.eventos.emit(EVENTO_ENVASE_DEVUELTO, evento);
  }
}
