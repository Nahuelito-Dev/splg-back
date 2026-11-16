/**
 * Un cliente no pertenece a ninguna distribuidora: puede comprarle a varias.
 * Para una distribuidora, "sus" clientes son los que le compraron al menos una
 * vez o los que ella dio de alta (`customer_distributor`), salvo los que dio
 * de baja (`removed_at`; un pedido nuevo o un alta nueva los reactiva). Esta es la única definición de esa pertenencia, y la usan todos los
 * módulos que acotan clientes por distribuidora.
 *
 * Excepción documentada en CONVENCIONES (como `reports`): lee la tabla
 * `order` en una subconsulta, sólo lectura. No puede pedírselo a
 * `OrderService` porque `order` depende, a través de `gateways`, de `users`.
 * Lo mismo vale para `customer_distributor`.
 *
 * @param columnaUserId la columna con el user_id del cliente, p. ej. `user.user_id`
 * @param parametro el nombre del parámetro con el id de la distribuidora
 * @returns la condición SQL, para usar en un `andWhere` o `orWhere`
 */
export function clienteDeLaDistribuidora(
  columnaUserId: string,
  parametro = 'distributorId',
): string {
  return (
    `((EXISTS (SELECT 1 FROM "order" pertenencia ` +
    `WHERE pertenencia.customer_id = ${columnaUserId} ` +
    `AND pertenencia.distributor_id = :${parametro}) ` +
    `OR EXISTS (SELECT 1 FROM customer_distributor pert_v ` +
    `WHERE pert_v.user_id = ${columnaUserId} ` +
    `AND pert_v.distributor_id = :${parametro})) ` +
    `AND NOT EXISTS (SELECT 1 FROM customer_distributor pert_b ` +
    `WHERE pert_b.user_id = ${columnaUserId} ` +
    `AND pert_b.distributor_id = :${parametro} ` +
    `AND pert_b.removed_at IS NOT NULL))`
  );
}

/**
 * Cualquier usuario de la distribuidora: chofer o admin de ella (su perfil lo
 * dice) o cliente que le compró o que ella dio de alta. Un super admin no es de ninguna, aunque su
 * perfil tenga una distribuidora cargada: sólo cuentan los perfiles con rol
 * `admin` (H-76), y sólo si el usuario mismo tiene ese rol: un perfil de admin
 * colgado de un cliente o un chofer no lo hace de la empresa (H-77). Misma
 * excepción de lectura que `clienteDeLaDistribuidora`.
 */
export function usuarioDeLaDistribuidora(
  columnaUserId: string,
  parametro = 'distributorId',
): string {
  return (
    `(EXISTS (SELECT 1 FROM delivery pert_d WHERE pert_d.user_id = ${columnaUserId} ` +
    `AND pert_d.distributor_id = :${parametro}) ` +
    `OR EXISTS (SELECT 1 FROM admin pert_a ` +
    `JOIN "user" pert_u ON pert_u.user_id = pert_a.user_id ` +
    `JOIN role pert_r ON pert_r.role_id = pert_u.role_id ` +
    `WHERE pert_a.user_id = ${columnaUserId} AND pert_r.type = 'admin' ` +
    `AND pert_a.distributor_id = :${parametro}) ` +
    `OR ${clienteDeLaDistribuidora(columnaUserId, parametro)})`
  );
}
