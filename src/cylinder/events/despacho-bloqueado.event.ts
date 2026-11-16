/** Nombre del evento que publica `cylinder` cuando rechaza un despacho por envases vencidos. */
export const EVENTO_DESPACHO_BLOQUEADO = 'cylinder.despacho-bloqueado';

/**
 * Se rechazó asignar a un pedido envases con la revisión vencida. El aviso al
 * panel lo hace un listener: un aviso que no sale no cambia el rechazo.
 */
export class DespachoBloqueadoEvent {
  constructor(
    readonly distributorId: string,
    readonly orderId: string | null,
    readonly serials: string[],
  ) {}
}
