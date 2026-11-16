import { BadRequestDomainError } from '../../../common/errors/domain.error';

/**
 * No hay stock suficiente de una garrafa para reservar la cantidad pedida
 * (`GasCylinderService.reservarStock`). El `GlobalExceptionFilter` la mapea a
 * 400, mismo status/mensaje que antes lanzaba `BadRequestException` directo.
 */
export class InsufficientStockError extends BadRequestDomainError {
  constructor(cylinderType: string) {
    super(`Stock insuficiente para ${cylinderType}`);
  }
}
