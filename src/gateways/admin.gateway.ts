import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import type { Namespace } from 'socket.io';
import { Logger } from '@nestjs/common';
import { RoleType } from '../common/constants/role-type.enum';
import { SocketIdentityService } from './socket-identity.service';
import { SocketDeSplg, salaDeUsuario } from './socket-data';

/**
 * Canal de tiempo real del PANEL ADMIN. A diferencia de customers/drivers (salas
 * por usuario), acá los admins de una misma distribuidora comparten una sala
 * (aislamiento entre tenants, H-77..H-84 también en vivo) y reciben los eventos
 * del ciclo de vida de los pedidos (creado/aceptado/en camino/entregado/
 * cancelado) DE SU distribuidora, para el dashboard y la campana de
 * notificaciones. El super admin es de la plataforma (modo soporte, §4.8 y D5):
 * entra sólo a la sala `platform`, que recibe los eventos de plataforma, nunca
 * los de una empresa — ni siquiera en una sesión de soporte (sin tiempo real
 * de empresa en soporte: el panel consulta por sondeo). Al terminar su sesión de
 * soporte recibe `support:ended` en su sala personal.
 *
 * Eventos del despacho (además de los `order:*` del ciclo de vida):
 *  - `order:no-drivers` `{ orderId, distributorId, reason, at }`: un pedido
 *    PENDING se quedó sin choferes a quién ofrecérselo. `reason` es
 *    `no_drivers_in_range` (no hay choferes elegibles cerca) o
 *    `all_drivers_exhausted` (los que había rechazaron o están en espera de
 *    re-oferta). Se emite una vez por agotamiento, no en cada reintento.
 *
 * El join lo decide el SERVIDOR a partir de la identidad resuelta del token
 * (`SocketIdentityService`), nunca el cliente: el panel no manda nada especial
 * al conectar, sigue siendo `io(url + '/admin', { auth: { token } })`.
 */
/** Evento del socket del panel cuando termina la sesión de soporte del super admin. */
export const EVENTO_FIN_DE_SOPORTE = 'support:ended';

@WebSocketGateway({
  namespace: 'admin',
})
export class AdminGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Namespace;
  private readonly logger = new Logger('AdminGateway');

  /** Sala de los super admin: sólo eventos de plataforma (no de una empresa). */
  static readonly SALA_PLATAFORMA = 'platform';

  constructor(private readonly identidades: SocketIdentityService) {}

  async handleConnection(client: SocketDeSplg): Promise<void> {
    const identidad = await this.identidades.identificar(client);

    if (!identidad) {
      this.logger.warn(`🚫 Admin rechazado (sin identidad): ${client.id}`);
      client.disconnect();
      return;
    }

    if (
      identidad.role !== RoleType.ADMIN &&
      identidad.role !== RoleType.SUPER_ADMIN
    ) {
      this.logger.warn(
        `🚫 ${identidad.email} quiso entrar al panel con rol ${identidad.role}`,
      );
      client.disconnect();
      return;
    }

    if (identidad.role === RoleType.ADMIN) {
      // Mismo criterio que `AuthGuard.resolveDistributor` en HTTP: un admin
      // SIN distribuidora en su perfil es un dato inconsistente, y no se
      // degrada a "ve todo" (eso sería fuga cross-tenant) — se rechaza, igual
      // que el guard HTTP lo rechaza con 401 (segunda revisión, punto 4).
      if (!identidad.distributorId) {
        this.logger.warn(
          `🚫 Admin sin distribuidora en su perfil: ${identidad.email}`,
        );
        client.disconnect();
        return;
      }
      await client.join(
        AdminGateway.salaDeDistribuidora(identidad.distributorId),
      );
    } else {
      // super_admin: la plataforma. Nada de una empresa por el socket.
      await client.join(AdminGateway.SALA_PLATAFORMA);
    }

    await client.join(salaDeUsuario(identidad.userId));
    this.logger.log(`🛠️ Admin conectado: ${identidad.email} (${client.id})`);
    client.emit('server:ack', { message: 'Conectado al panel en vivo' });
  }

  handleDisconnect(): void {
    // sin estado por-cliente que limpiar (la sala se libera sola)
  }

  /**
   * Emite un evento a los admins DE esa distribuidora (y sólo a ellos: el super
   * admin no recibe la operación de las empresas). Sin `distributorId` (evento
   * que no es de un tenant en particular) va a la sala de plataforma.
   */
  notifyAdmins(
    event: string,
    payload: unknown,
    distributorId?: string | null,
  ): void {
    if (distributorId) {
      this.server
        .to(AdminGateway.salaDeDistribuidora(distributorId))
        .emit(event, payload);
      return;
    }
    this.notifyPlatform(event, payload);
  }

  /** Un evento de plataforma: sólo a los super admin. */
  notifyPlatform(event: string, payload: unknown): void {
    this.server.to(AdminGateway.SALA_PLATAFORMA).emit(event, payload);
  }

  /**
   * La sesión de soporte del super admin terminó (revocada, vencida, finalizada):
   * el panel sale del modo al instante (el sondeo de `current` cubre si no llega).
   */
  avisarFinDeSoporte(
    userId: string,
    payload: { sessionId: string; status: string; endReason: string | null },
  ): void {
    this.server.to(salaDeUsuario(userId)).emit(EVENTO_FIN_DE_SOPORTE, payload);
  }

  private static salaDeDistribuidora(distributorId: string): string {
    return `admins:${distributorId}`;
  }
}
