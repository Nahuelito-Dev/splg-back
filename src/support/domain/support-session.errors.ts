import {
  BadRequestDomainError,
  ConflictDomainError,
} from '../../common/errors/domain.error';
import { CODIGOS_DE_ERROR } from '../../common/errors/con-codigo';

/** La sesión no está pendiente: ya se aprobó, se rechazó, se retiró o caducó. */
export class SesionNoPendienteError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.SUPPORT_SESSION_NOT_PENDING;
  constructor() {
    super('La solicitud de soporte ya no está pendiente');
  }
}

/** La solicitud pasó sus 24 horas sin respuesta. */
export class SolicitudCaducadaError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.SUPPORT_REQUEST_EXPIRED;
  constructor() {
    super('La solicitud de soporte caducó: pasaron 24 horas sin respuesta');
  }
}

/** La sesión no está activa (terminó o todavía no empezó): no hay nada que cortar. */
export class SesionYaTerminadaError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.SUPPORT_SESSION_ALREADY_ENDED;
  constructor() {
    super('La sesión de soporte no está activa');
  }
}

/** Al aprobar sólo se puede acortar la duración y achicar el alcance. */
export class AprobacionExcedeLoPedidoError extends BadRequestDomainError {
  override readonly code = CODIGOS_DE_ERROR.SUPPORT_APPROVAL_EXCEEDS_REQUEST;
  constructor(mensaje: string) {
    super(mensaje);
  }
}

/** Una duración que no es de las permitidas para ese tipo de acceso. */
export class DuracionInvalidaError extends BadRequestDomainError {
  constructor(mensaje: string) {
    super(mensaje);
  }
}
