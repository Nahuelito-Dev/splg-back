import { OrderStatus } from '../entities/order.entity';
import { InvalidOrderTransitionError } from './errors/invalid-order-transition.error';

/**
 * Máquina de estados del pedido (dominio puro). Centraliza las transiciones
 * VÁLIDAS que antes estaban implícitas y repartidas por OrderService.
 *
 * Reglas (SRS):
 *  - PENDING     → ACCEPTED (chofer acepta) | CANCELLED (cliente/admin)
 *  - ACCEPTED    → ON_THE_WAY (chofer sale) | PENDING (chofer cancela → re-dispatch)
 *                  | CANCELLED (cliente/admin)
 *  - ON_THE_WAY  → DELIVERED (chofer confirma) | CANCELLED (solo admin)
 *                  | PENDING (se libera) | ACCEPTED (hoja de ruta: no se pudo
 *                  entregar y la parada vuelve al final de la cola del MISMO
 *                  chofer; sólo por la ejecución de la hoja, no por el
 *                  endpoint genérico de estado)
 *  - DELIVERED / CANCELLED = terminales.
 *
 * NOTA: los estados ARRIVED y SIN_COBERTURA aún no existen en el enum; cuando se
 * agreguen (Fase modelo de datos) se suman aquí sus transiciones.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, OrderStatus[]>> = {
  // RESERVED → PENDING (el sistema la activa el día agendado con seña paga) |
  // CANCELLED (cliente/admin cancela, o el cron la expira por seña impaga).
  [OrderStatus.RESERVED]: [OrderStatus.PENDING, OrderStatus.CANCELLED],
  [OrderStatus.PENDING]: [OrderStatus.ACCEPTED, OrderStatus.CANCELLED],
  [OrderStatus.ACCEPTED]: [
    OrderStatus.ON_THE_WAY,
    OrderStatus.PENDING,
    OrderStatus.CANCELLED,
  ],
  // ON_THE_WAY → DELIVERED (entrega) | CANCELLED (admin) | PENDING (el chofer no
  // puede completar la entrega en curso → vuelve al pool para re-despacho) |
  // ACCEPTED (hoja de ruta, F34: no se entregó en el primer intento y la parada
  // vuelve al final de la cola del mismo chofer).
  [OrderStatus.ON_THE_WAY]: [
    OrderStatus.DELIVERED,
    OrderStatus.CANCELLED,
    OrderStatus.PENDING,
    OrderStatus.ACCEPTED,
  ],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
};

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
];

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return true; // idempotencia: re-aplicar el mismo estado es no-op
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Igual que canTransition pero lanza `InvalidOrderTransitionError` (dominio
 * puro) con mensaje claro si es inválida. `GlobalExceptionFilter` la mapea a
 * 400, así que el status HTTP no cambia para los callers.
 */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidOrderTransitionError(from, to);
  }
}

/**
 * ÚNICO punto para mutar `order.status`: valida la transición contra la máquina
 * de estados y recién ahí la aplica. Todo el código que cambie el estado de un
 * pedido debe pasar por acá (no asignar `order.status = X` directo), para que el
 * invariante "las transiciones son legales" se cumpla siempre.
 */
export function transitionOrder(
  order: { status: OrderStatus },
  to: OrderStatus,
): void {
  assertTransition(order.status, to);
  order.status = to;
}
