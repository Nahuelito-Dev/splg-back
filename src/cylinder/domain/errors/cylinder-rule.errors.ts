import {
  BadRequestDomainError,
  ConflictDomainError,
} from '../../../common/errors/domain.error';

/** Un dato del envase que no cumple una regla del dominio (400). */
export class ReglaDeEnvaseError extends BadRequestDomainError {
  constructor(message: string) {
    super(message);
  }
}

/** El estado actual del envase no admite la operación (409). */
export class EnvaseEnConflictoError extends ConflictDomainError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * CU-135. Se quiso despachar envases con la revisión vencida: el despacho se
 * rechaza completo y se informan los seriales para elegir otros.
 */
export class EnvasesVencidosError extends ConflictDomainError {
  readonly code = 'CYLINDER_EXPIRED';

  constructor(readonly serials: string[]) {
    super(`Envases con la revisión vencida: ${serials.join(', ')}`);
  }
}
