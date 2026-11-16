import { Injectable, Logger } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { AuthService } from '../auth/auth.service';
import { User } from '../users/entities/user.entity';
import { RoleType } from '../common/constants/role-type.enum';
import { errorMessage } from '../common/errors/error-message';
import { SocketDeSplg, tokenDelHandshake } from './socket-data';

/** Quién es, de verdad, el que está del otro lado del socket. */
export interface IdentidadDeSocket {
  userId: string;
  email: string;
  role: RoleType;
  /**
   * Distribuidora del perfil (admin/delivery), `null` para `customer` y para
   * `super_admin` (no tiene una sola: ve todas). La usa `AdminGateway` para
   * unir al admin a la sala de SU distribuidora (aislamiento H-77..H-84
   * también en tiempo real).
   */
  distributorId: string | null;
  /**
   * Cuándo vence el token del handshake (ms desde epoch). Vencido, la conexión
   * se corta (`SocketSesionesService`) y el cliente vuelve con uno nuevo: así
   * la identidad se vuelve a resolver contra la base al menos una vez por hora.
   */
  expiraEn: number | null;
}

/**
 * Resuelve la identidad REAL de una conexión de socket a partir de su token, y
 * la deja guardada en el propio socket.
 *
 * Existe porque el token de Firebase trae el `uid` y el email, pero NO el
 * `user_id` interno, que es con lo que se arman las salas de tiempo real. Sin
 * este paso, los gateways no tienen más remedio que creerle al identificador
 * que manda el cliente en el cuerpo del mensaje — y ahí cualquiera se mete en
 * la sala de otro y le sigue la entrega en vivo.
 *
 * Se resuelve UNA vez por conexión, en el handshake, y no en cada mensaje.
 */
@Injectable()
export class SocketIdentityService {
  private readonly logger = new Logger(SocketIdentityService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
  ) {}

  /**
   * Valida el token del handshake, resuelve el usuario interno y lo guarda en
   * el socket. Devuelve `null` si no hay token, si no es válido o si el email
   * no corresponde a ningún usuario activo: el gateway corta la conexión.
   */
  async identificar(client: SocketDeSplg): Promise<IdentidadDeSocket | null> {
    const token = tokenDelHandshake(client);

    if (!token) {
      return null;
    }

    let email: string;
    let exp: number | undefined;
    try {
      const decoded = await this.authService.decodeToken(token);
      email = decoded.email;
      exp = decoded.exp;
    } catch (error) {
      this.logger.warn(`Token de socket inválido: ${errorMessage(error)}`);
      return null;
    }

    if (!email) {
      return null;
    }

    // Sólo la relación que hace falta para decidir el permiso (+ delivery/
    // admins, livianas, para resolver la distribuidora del staff).
    const user = await this.usersService.findOneWithRoleByEmail(email);

    if (!user) {
      this.logger.warn(`Socket con email sin usuario: ${email}`);
      return null;
    }

    if (user.blocked) {
      this.logger.warn(`Socket de un usuario bloqueado: ${email}`);
      return null;
    }

    const role = user.role?.type as RoleType;
    const identidad: IdentidadDeSocket = {
      userId: user.userId,
      email,
      // Un usuario sin rol no puede operar: el gateway lo rechaza por rol.
      role,
      distributorId: this.resolverDistribuidora(user, role),
      expiraEn: exp ? exp * 1000 : null,
    };

    client.data.identidad = identidad;
    return identidad;
  }

  /**
   * La identidad del socket, resolviéndola si el handshake todavía no terminó.
   *
   * Hace falta porque `handleConnection` es asíncrono (consulta la base) y
   * socket.io **no espera** a que termine antes de entregar los mensajes: las
   * apps emiten su `join` apenas conectan, así que ese primer mensaje suele
   * llegar antes de que la identidad esté guardada. Leer sólo lo cacheado
   * dejaba al cliente afuera de su propia sala de forma intermitente.
   *
   * La resolución se cachea en el socket, así que esto consulta la base una
   * sola vez por conexión, no una vez por mensaje.
   */
  async obtener(client: SocketDeSplg): Promise<IdentidadDeSocket | null> {
    return client.data.identidad ?? (await this.identificar(client));
  }

  /**
   * Misma regla que `AuthGuard.resolveDistributor` en HTTP: el staff
   * (admin/delivery) se deriva de SU perfil, nunca de lo que mande el
   * cliente. `customer` y `super_admin` no tienen una sola (el socket no
   * soporta "ver como", a diferencia del header `X-Distributor` en HTTP) →
   * `null`.
   */
  private resolverDistribuidora(user: User, role: RoleType): string | null {
    if (role === RoleType.DELIVERY) {
      return user.delivery?.distributorId ?? null;
    }
    if (role === RoleType.ADMIN) {
      return user.admins?.[0]?.distributorId ?? null;
    }
    return null;
  }
}
