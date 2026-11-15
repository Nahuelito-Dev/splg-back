/**
 * El pedido cambió de chofer: lo reasignaron a otro o volvió a buscar uno.
 * Se emite después del commit; lo escucha la mensajería para cerrar la
 * conversación del pedido con el chofer anterior (Corrección 1 de CH3).
 */
export const EVENTO_CHOFER_DEL_PEDIDO_CAMBIADO = 'pedido.chofer-cambiado';

export interface ChoferDelPedidoCambiado {
  orderId: string;
  distributorId: string;
  /** Usuario del chofer anterior. */
  anterior: string;
  /** Usuario del chofer nuevo; nulo si el pedido volvió a buscar chofer. */
  nuevo: string | null;
}
