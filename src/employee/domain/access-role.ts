import { RoleType } from '../../common/constants/role-type.enum';
import { JobPositionCategory } from '../entities/job-position.entity';

/**
 * Qué rol tiene la cuenta que corresponde a cada categoría de puesto (D1: el
 * sistema mantiene sus cuatro roles). Los administrativos conservan su cuenta
 * `admin` y su legajo, pero la cuenta sólo se OTORGA a un chofer
 * (`puedeOtorgarseCuenta`): los demás empleados no acceden al sistema.
 * Qué rol admite cada categoría de puesto (D1: el sistema mantiene
 * sus cuatro roles, no hay roles de depósito, caja ni ventas). `null` = esa
 * categoría no admite cuenta.
 */
export function rolDeAcceso(
  categoria: JobPositionCategory,
): RoleType.DELIVERY | RoleType.ADMIN | null {
  switch (categoria) {
    case JobPositionCategory.DRIVER:
      return RoleType.DELIVERY;
    case JobPositionCategory.ADMINISTRATION:
    case JobPositionCategory.MANAGEMENT:
      return RoleType.ADMIN;
    default:
      return null;
  }
}

/** `POST /employees/:id/account`: sólo el chofer tiene cuenta. */
export function puedeOtorgarseCuenta(categoria: JobPositionCategory): boolean {
  return categoria === JobPositionCategory.DRIVER;
}
