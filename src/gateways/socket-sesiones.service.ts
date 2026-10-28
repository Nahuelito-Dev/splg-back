import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import type { Namespace } from 'socket.io';
import {
  AccesoRevocadoEvent,
  EVENTO_ACCESO_REVOCADO,
} from '../common/events/acceso-revocado.event';
import { AdminGateway } from './admin.gateway';
import { CustomersGateway } from './customers.gateway';
import { DriversGateway } from './drivers.gateway';
import { salaDeUsuario, type SocketDeSplg } from './socket-data';

/** Cada cuánto se buscan conexiones con el token vencido. */
const REVISION_MS = 60_000;

/** Aviso antes de cortar: el cliente reconecta con un token nuevo. */
export const EVENTO_SESION_VENCIDA = 'server:session-expired';
/** Aviso antes de cortar: el cliente NO reconecta (bloqueo o baja). */
export const EVENTO_ACCESO_REVOCADO_SOCKET = 'server:access-revoked';

/**
 * La identidad de un socket se resuelve una vez, en el handshake. Esto la
 * mantiene vigente mientras la conexión dura:
 *
 * - **Token vencido**: cada minuto se cortan las conexiones cuyo token ya
 *   venció, con aviso previo. El cliente vuelve con un token nuevo y la
 *   identidad se resuelve otra vez contra la base (rol, distribuidora,
 *   bloqueo).
 * - **Bloqueo o baja**: se cortan en el momento todas las conexiones del
 *   usuario, en los tres namespaces y en cualquier instancia del back (la sala
 *   personal viaja por el adapter de Redis).
 */
@Injectable()
export class SocketSesionesService {
  private readonly logger = new Logger(SocketSesionesService.name);

  constructor(
    private readonly admin: AdminGateway,
    private readonly customers: CustomersGateway,
    private readonly drivers: DriversGateway,
  ) {}

  @Interval(REVISION_MS)
  cortarSesionesVencidas(ahora: number = Date.now()): number {
    let cortadas = 0;
    for (const espacio of this.espacios()) {
      // Sólo las conexiones de esta instancia: cada una revisa las suyas.
      for (const socket of espacio.sockets.values() as Iterable<SocketDeSplg>) {
        const expiraEn = socket.data.identidad?.expiraEn;
        if (expiraEn == null || expiraEn > ahora) continue;
        socket.emit(EVENTO_SESION_VENCIDA, {
          message: 'La sesión venció: reconectá con un token nuevo',
        });
        socket.disconnect();
        cortadas++;
      }
    }
    if (cortadas > 0) {
      this.logger.log(`⏱️ ${cortadas} conexión(es) con el token vencido`);
    }
    return cortadas;
  }

  @OnEvent(EVENTO_ACCESO_REVOCADO)
  revocar({ userId, motivo }: AccesoRevocadoEvent): void {
    const sala = salaDeUsuario(userId);
    for (const espacio of this.espacios()) {
      espacio.to(sala).emit(EVENTO_ACCESO_REVOCADO_SOCKET, { motivo });
      espacio.in(sala).disconnectSockets();
    }
    this.logger.log(`🚫 Conexiones de ${userId} cortadas (${motivo})`);
  }

  /** Sin servidor de sockets (seed, CLI con `createApplicationContext`) no hay namespaces. */
  private espacios(): Namespace[] {
    return [
      this.admin.server,
      this.customers.server,
      this.drivers.server,
    ].filter(Boolean);
  }
}
