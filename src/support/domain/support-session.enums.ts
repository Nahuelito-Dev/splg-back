/** Cómo se abrió la sesión: con aprobación de la empresa o por emergencia (con aviso inmediato). */
export enum SupportSessionKind {
  CONSENTED = 'consented',
  EMERGENCY = 'emergency',
}

/**
 * Estados de una sesión de soporte. Pendiente → activa por aprobación (o
 * directo a activa en emergencia o con autoaprobación); los otros seis son
 * finales.
 */
export enum SupportSessionStatus {
  PENDING = 'pending',
  REJECTED = 'rejected',
  EXPIRED_REQUEST = 'expired_request',
  CANCELLED = 'cancelled',
  ACTIVE = 'active',
  ENDED = 'ended',
  REVOKED = 'revoked',
  EXPIRED = 'expired',
}

/** Qué datos puede ver la sesión además de lo básico (lo aplica la etapa E2). */
export enum SupportScope {
  PERSONAL_DATA = 'personal_data',
  FILES = 'files',
  EXPORTS = 'exports',
}

/** Por qué terminó una sesión activa. */
export enum SupportEndReason {
  EXIT = 'exit',
  REVOKED_BY_COMPANY = 'revoked_by_company',
  REVOKED_BY_PLATFORM = 'revoked_by_platform',
  EXPIRED = 'expired',
}
