import { BadRequestDomainError } from '../../../common/errors/domain.error';

/**
 * Se intentó activar una reserva (RESERVED → PENDING) sin cumplir las
 * condiciones que exige la política de reservas (seña paga y día agendado
 * cumplido). El `GlobalExceptionFilter` la mapea a 400.
 */
export class ReservationNotActivableError extends BadRequestDomainError {
  constructor(reason: string) {
    super(reason);
  }
}
