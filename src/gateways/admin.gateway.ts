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
 * notificaciones. El super admin no tiene una sola distribuidora (el socket no
 * soporta "ver como", a diferencia del header `X-Distributor` en HTTP): se une
 * a una sala aparte que recibe todo.
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
@WebSocketGateway({
  namespace: 'admin',
})
export class AdminGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Namespace;
  private readonly logger = new Logger('AdminGateway');

  /** Sala de los super admin: ven TODO, sin importar la distribuidora. */
  private static readonly SALA_SUPER_ADMIN = 'admins:super';

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
      // super_admin: no tiene una sola distribuidora (el socket no soporta
      // "ver como"), ve todas.
      await client.join(AdminGateway.SALA_SUPER_ADMIN);
    }

    await client.join(salaDeUsuario(identidad.userId));
    this.logger.log(`🛠️ Admin conectado: ${identidad.email} (${client.id})`);
    client.emit('server:ack', { message: 'Conectado al panel en vivo' });
  }

  handleDisconnect(): void {
    // sin estado por-cliente que limpiar (la sala se libera sola)
  }

  /**
   * Emite un evento del ciclo de vida del pedido a los admins DE esa
   * distribuidora + a los super admin (que ven todas). Sin `distributorId`
   * (evento que no es de un tenant en particular) sólo llega a los super
   * admin.
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
    }
    this.server.to(AdminGateway.SALA_SUPER_ADMIN).emit(event, payload);
  }

  private static salaDeDistribuidora(distributorId: string): string {
    return `admins:${distributorId}`;
  }
}
