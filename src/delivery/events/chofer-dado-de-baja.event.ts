import { EntityManager } from 'typeorm';

/**
 * Nombre del evento de la baja de un chofer: lo emite `UsersService.remove`
 * (también por `DELETE /delivery/:id`, que delega en él) dentro de la
 * transacción de la baja.
 */
export const EVENTO_CHOFER_DADO_DE_BAJA = 'chofer.dado-de-baja';

/**
 * Se está dando de baja un chofer. Quien tenga que reaccionar (hoy: `car`,
 * liberando el vehículo en uso) lo escucha acá en vez de que `users` lo llame
 * directo: así `users` no depende de `car` (CONVENCIONES §4; mismo patrón que
 * `distribuidora.creada`).
 *
 * Se emite con `emitAsync` y los oyentes tienen que escribir con `manager`,
 * la transacción de la baja: si uno falla, la baja entera se revierte.
 */
export class ChoferDadoDeBajaEvent {
  constructor(
    readonly deliveryId: string,
    readonly manager: EntityManager,
  ) {}
}
