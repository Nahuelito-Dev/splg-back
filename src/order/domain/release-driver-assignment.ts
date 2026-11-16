import { Order } from '../entities/order.entity';

/**
 * Limpia la asignación de chofer de un pedido que vuelve a PENDING: lo libera
 * el propio chofer (no puede completar la entrega → re-dispatch), o un admin
 * que lo destraba a mano vía `PATCH /orders/:id/status`.
 *
 * Sin esto el pedido queda "pendiente con chofer": `findAvailable` filtra por
 * `deliveryId IS NULL`, así que no vuelve a aparecer en el pool de choferes
 * (desajuste medido el 26/09 contra la API). Un solo lugar para esta mutación:
 * la usan tanto `CancelOrderUseCase` (liberación por el chofer) como
 * `UpdateOrderStatusUseCase` (cualquier actor que mueva el pedido a PENDING),
 * para que no se desincronicen.
 *
 * Pura: no toca infraestructura. El caller decide si además hay que cerrar
 * alguna oferta de despacho vigente (`DispatchOrchestratorService`) y qué
 * side-effects de tiempo real disparar.
 *
 * Limpia TANTO `deliveryId` como la relación `delivery`: `Order.delivery` es
 * un `@ManyToOne` con `@JoinColumn({ name: 'delivery_id' })` sobre la MISMA
 * columna que `deliveryId`. Si `findByIdFull` trajo la relación cargada y
 * sólo se pisa `deliveryId`, TypeORM prioriza el valor de la relación al
 * guardar y la columna real en la base NO se limpia (verificado contra la
 * API el 30/09: el DTO mostraba `deliveryId: null` pero la fila seguía con
 * el chofer viejo). Las dos tienen que quedar en `null` a la vez.
 *
 * También limpia el snapshot `vehicle*`: era el vehículo de ESTE chofer
 * (revisión de vehículo en uso), así que un pedido que vuelve a PENDING sin
 * chofer tampoco tiene sentido que siga mostrando uno. El próximo que lo
 * acepte guarda el suyo.
 */
export function releaseDriverAssignment(order: Order): void {
  order.deliveryId = null;
  order.delivery = null;
  order.acceptedAt = null;
  order.onTheWayAt = null;
  order.vehicleCarId = null;
  order.vehiclePatent = null;
  order.vehicleBrand = null;
  order.vehicleModel = null;
}
