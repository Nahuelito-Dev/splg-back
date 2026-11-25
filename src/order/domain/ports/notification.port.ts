import type {
  DesgloseDelEfectivo,
  EfectivoDeSalida,
} from '../efectivo-a-cobrar';

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
 * NOTA de alcance: cubre lo que consumen `CreateOrderUseCase`/
 * `UpdateOrderStatusUseCase` y el aviso de llegada de `OrderService`.
 * `DispatchOrchestratorService`
 * también usa `NotificationsService.sendOfferPushToDriver` (push de oferta al
 * chofer), pero se deja fuera de este puerto a propósito: no es parte de la
 * inconsistencia señalada en la revisión (los use-cases de `order`), y
 * ensancharlo ahí es un cambio de alcance mayor que no aporta al P2-8.
 */
/** Resultado del push de llegada al cliente. */
export type PushDeLlegada = 'sent' | 'no_token' | 'failed';

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
    efectivo?: DesgloseDelEfectivo | null,
    distributorId?: string | null,
  ): Promise<{ success: boolean; messageId?: string; error?: string }>;

  /**
   * «Tené listos $X en efectivo» cuando el chofer sale hacia el cliente. Una
   * sola vez por pedido; best-effort, nunca lanza.
   */
  abstract sendCashReadyPush(
    customerId: string,
    orderId: string,
    efectivo: EfectivoDeSalida,
    distributorId?: string | null,
  ): Promise<'sent' | 'duplicate' | 'no_token' | 'failed'>;

  /**
   * Avisa al cliente que el repartidor llegó al domicilio (push best-effort,
   * complementario al socket `order:arrived`). Nunca lanza: si falla, el aviso
   * en tiempo real ya salió y el flujo del pedido no se interrumpe. Devuelve si
   * el push salió (`sent`), si el cliente no tiene token (`no_token`) o si FCM
   * falló o no confirmó a tiempo (`failed`).
   */
  abstract sendArrivalPushToCustomer(
    customerId: string,
    orderId: string,
    driverName: string,
    distributorId?: string | null,
  ): Promise<PushDeLlegada>;

  /**
   * Avisa al cliente que su pago se aprobó (push best-effort, complementario
   * al socket `order:payment-approved`). Nunca lanza.
   */
  abstract sendPaymentApprovedPush(
    customerId: string,
    orderId: string,
    esSena?: boolean,
    distributorId?: string | null,
  ): Promise<void>;

  /**
   * Push genérico sobre un pedido (pasó al reparto común, se devolvió un pago).
   * Best-effort: nunca lanza.
   */
  abstract sendOrderNoticePush(
    customerId: string,
    orderId: string,
    aviso: { title: string; body: string; event: string },
    distributorId?: string | null,
  ): Promise<void>;
}
