import { NotFoundDomainError } from '../../../common/errors/domain.error';

/**
 * La garrafa a reservar/restituir no existe (`StockReservationService`). El
 * `GlobalExceptionFilter` la mapea a 404, mismo status/mensaje que antes
 * lanzaba `NotFoundException` directo.
 */
export class GasCylinderNotFoundError extends NotFoundDomainError {
  constructor(gasCylinderId: string) {
    super(`Garrafa no encontrada: ${gasCylinderId}`);
  }
}
