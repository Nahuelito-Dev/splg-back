import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from '../entities/order.entity';

/**
 * Máquina de estados del pedido (dominio puro). Centraliza las transiciones
 * VÁLIDAS que antes estaban implícitas y repartidas por OrderService.
 *
 * Reglas (SRS):
 *  - PENDING     → ACCEPTED (chofer acepta) | CANCELLED (cliente/admin)
 *  - ACCEPTED    → ON_THE_WAY (chofer sale) | PENDING (chofer cancela → re-dispatch)
 *                  | CANCELLED (cliente/admin)
 *  - ON_THE_WAY  → DELIVERED (chofer confirma) | CANCELLED (solo admin)
 *  - DELIVERED / CANCELLED = terminales.
 *
 * NOTA: los estados ARRIVED y SIN_COBERTURA aún no existen en el enum; cuando se
 * agreguen (Fase modelo de datos) se suman aquí sus transiciones.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, OrderStatus[]>> = {
  [OrderStatus.PENDING]: [OrderStatus.ACCEPTED, OrderStatus.CANCELLED],
  [OrderStatus.ACCEPTED]: [
    OrderStatus.ON_THE_WAY,
    OrderStatus.PENDING,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.ON_THE_WAY]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
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

/** Igual que canTransition pero lanza 400 con mensaje claro si es inválida. */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new BadRequestException(
      `Transición de pedido inválida: ${from} → ${to}`,
    );
  }
}
