import { BadRequestDomainError } from '../../../common/errors/domain.error';

/**
 * El stock vendible de una garrafa quedaría negativo: lo que se quiere sacar
 * está reservado por pedidos abiertos (`GasCylinderService.ajustarVendible`).
 * El `GlobalExceptionFilter` la mapea a 400.
 */
export class VendibleInsuficienteError extends BadRequestDomainError {
  constructor(cylinderType: string, vendibleActual: number) {
    super(
      `El stock vendible de ${cylinderType} quedaría negativo: hay ${vendibleActual} vendibles y el resto está reservado por pedidos abiertos`,
    );
  }
}
