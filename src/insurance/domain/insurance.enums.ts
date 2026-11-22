/** Ciclo de una cuota: pendiente, paga o cancelada (con la póliza). Paga y cancelada no vuelven atrás. */
export enum InstallmentStatus {
  PENDING = 'pending',
  PAID = 'paid',
  CANCELLED = 'cancelled',
}

/**
 * Aprobación del pago de una cuota (human-in-the-loop): el aviso de los 5 días la
 * deja `awaiting`; el admin la aprueba (`approved`) y recién ahí se registra el pago.
 * `none`: todavía no se pidió. Una cuota `awaiting` no admite el pago.
 */
export enum InstallmentApprovalStatus {
  NONE = 'none',
  AWAITING = 'awaiting',
  APPROVED = 'approved',
}

/** Estado de una póliza respecto de hoy, derivado de sus fechas y de si se canceló. */
export enum PolicyStatus {
  ACTIVE = 'active',
  UPCOMING = 'upcoming',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

/** Cuántos días antes del vencimiento de una cuota se avisa. */
export const DIAS_DE_AVISO_DE_CUOTA = 5;

/** Cuántos días antes de que venza la póliza se avisa. */
export const DIAS_DE_AVISO_DE_POLIZA = 30;

/** Días de gracia que se proponen si el alta no indica otros. */
export const DIAS_DE_GRACIA_POR_OMISION = 5;
