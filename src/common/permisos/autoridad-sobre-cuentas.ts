import type { EntityManager } from 'typeorm';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

/** Quién pide el cambio sobre la cuenta de otro (sale de `@CurrentUser()`). */
export type ActorSobreCuentas = Pick<
  AuthenticatedUser,
  'user_id' | 'role' | 'actuaComoEmpresaPropia'
>;

/** La cuenta sobre la que se actúa y el tipo de su rol (`role.type`). */
export interface CuentaDestino {
  userId: string;
  rol: string | undefined;
}

export interface OpcionesSobreCuentas {
  /** El cambio incluye la contraseña de la cuenta. */
  cambiaContraseña?: boolean;
  /**
   * La transacción que escribe el cambio. Con ella, la regla se evalúa ahí
   * adentro y, si el destino es un administrador, con el cerrojo de los roles
   * de la empresa (`bloquearGestoresDeRoles`): un cambio de rol concurrente
   * espera y no la saltea.
   */
  manager?: EntityManager;
}

/**
 * La misma regla, para repetir dentro de la transacción que escribe (la
 * arma quien conoce al actor y se la pasa al servicio que abre la transacción).
 */
export type AutorizarEnTransaccion = (manager: EntityManager) => Promise<void>;

/**
 * Puerto: si quien pide puede modificar, bloquear o dar de baja la cuenta de
 * otro usuario. La regla vive en `admin` (`StaffRoleService`), dueño de los
 * roles del personal; `users` la consume por este puerto porque `admin` ya
 * depende de `users` (CONVENCIONES §4: sin `forwardRef`). El enlace lo hace
 * `AutoridadSobreCuentasModule`, global.
 *
 * Nadie sube ni baja a quien tiene más permisos: sobre otro administrador de
 * la empresa hace falta `administradores.gestionar` y todos los permisos de
 * su rol; sobre un chofer `personal.gestionar`; sobre un cliente
 * `clientes.gestionar`. La contraseña de otro administrador sólo la cambia el
 * super admin.
 */
export abstract class AutoridadSobreCuentas {
  abstract assertPuedeAdministrarA(
    actor: ActorSobreCuentas,
    destino: CuentaDestino,
    distributorId: string | null,
    opciones?: OpcionesSobreCuentas,
  ): Promise<void>;
}
