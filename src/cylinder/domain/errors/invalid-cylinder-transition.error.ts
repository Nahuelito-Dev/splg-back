import { BadRequestDomainError } from '../../../common/errors/domain.error';
import { valorLegible } from '../../../common/validation/etiquetas';
import { CylinderState } from '../cylinder-state';

/**
 * Se intentó una transición de estado de envase no permitida por
 * `CYLINDER_TRANSITIONS` (`cylinder-state.machine.ts`). El
 * `GlobalExceptionFilter` la mapea a 400, mismo status/mensaje que antes
 * lanzaba `BadRequestException` directo desde la state machine.
 */
export class InvalidCylinderTransitionError extends BadRequestDomainError {
  constructor(from: CylinderState, to: CylinderState) {
    super(
      `Transición de envase inválida: ${valorLegible(from)} → ${valorLegible(to)}`,
    );
  }
}
