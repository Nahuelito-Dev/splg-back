import { BadRequestDomainError } from '../../../common/errors/domain.error';
import { OrderStatus } from '../../entities/order.entity';

/**
 * Se intentó una transición de estado de pedido no permitida por
 * `ORDER_TRANSITIONS` (`order-status.machine.ts`). El `GlobalExceptionFilter`
 * la mapea a 400, mismo status/mensaje que antes lanzaba `BadRequestException`
 * directo desde la state machine.
 */
export class InvalidOrderTransitionError extends BadRequestDomainError {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Transición de pedido inválida: ${from} → ${to}`);
  }
}
