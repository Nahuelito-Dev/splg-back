/**
 * PUERTO de notificaciones al cliente visto desde el pedido. Los use-cases de
 * `order` (crear/actualizar estado) dependen de ESTA interfaz, no del módulo
 * `notifications` concreto (que a su vez conoce Firebase): "avisale al cliente
 * que su pedido se confirmó" se expresa acá, y `NotificationAdapter`
 * (infrastructure) delega en `NotificationsService` el cómo.
 *
 * Se declara como clase abstracta porque es el token de inyección idiomático de
 * NestJS para puertos. Ver NotificationAdapter (infrastructure).
 *
 * NOTA de alcance: solo cubre `sendOrderConfirmation`, que es lo ÚNICO que usan
 * `CreateOrderUseCase`/`UpdateOrderStatusUseCase`. `DispatchOrchestratorService`
 * también usa `NotificationsService.sendOfferPushToDriver` (push de oferta al
 * chofer), pero se deja fuera de este puerto a propósito: no es parte de la
 * inconsistencia señalada en la revisión (los use-cases de `order`), y
 * ensancharlo ahí es un cambio de alcance mayor que no aporta al P2-8.
 */
export abstract class NotificationPort {
  /**
   * Notifica al cliente que su pedido fue confirmado/actualizado (push best-
   * effort). Nunca debe romper el flujo del pedido si falla — eso lo maneja el
   * caller, no este puerto.
   */
  abstract sendOrderConfirmation(
    customerId: string,
    orderId: string,
    token?: string,
  ): Promise<{ success: boolean; messageId?: string; error?: string }>;
}
