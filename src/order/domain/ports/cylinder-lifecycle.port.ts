/**
 * PUERTO del ciclo de vida del envase físico visto desde el pedido. El caso de
 * uso de estado del pedido depende de ESTA interfaz, no del módulo cylinder:
 * "el pedido se entregó" se expresa acá, y un adapter delega en CylinderService
 * el avance de los envases (DISPATCHED → WITH_CUSTOMER).
 *
 * Se declara como clase abstracta porque es el token de inyección idiomático de
 * NestJS para puertos. Ver CylinderLifecycleAdapter (infrastructure).
 */
export abstract class CylinderLifecyclePort {
  /**
   * Notifica que un pedido pasó a DELIVERED: avanza los envases despachados en
   * ese pedido a WITH_CUSTOMER. No-op si la distribuidora no usa envases.
   * Devuelve cuántos avanzó.
   */
  abstract onOrderDelivered(
    orderId: string,
    distributorId?: string | null,
  ): Promise<number>;
}
