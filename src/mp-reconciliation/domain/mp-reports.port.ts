/** Estado de un reporte de liberaciones en Mercado Pago, normalizado. */
export type MpReportStatus = 'pending' | 'processed' | 'failed';

export interface MpReportRequest {
  /** Inicio del rango (instante). */
  from: Date;
  /** Fin del rango (instante, inclusive). */
  to: Date;
}

/** Un reporte de la lista de Mercado Pago. */
export interface MpReportRef {
  /** Id del reporte en Mercado Pago, si lo informa. */
  id: string | null;
  /** Nombre del archivo para bajarlo; sólo cuando ya se generó. */
  fileName: string | null;
  status: MpReportStatus;
  beginDate: Date | null;
  endDate: Date | null;
  generationDate: Date | null;
}

/** Lo que Mercado Pago contesta al pedir el reporte: su id y el rango que tomó (lo redondea al día de la cuenta). */
export interface MpReportRequested {
  reportId: string | null;
  beginDate: Date | null;
  endDate: Date | null;
}

export type MpReportsErrorKind =
  | 'not_configured'
  | 'unauthorized'
  | 'rate_limited'
  | 'rejected'
  | 'timeout'
  | 'unavailable'
  | 'invalid_response';

/** Error tipado de la integración con los reportes de Mercado Pago. */
export class MpReportsError extends Error {
  constructor(
    readonly kind: MpReportsErrorKind,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'MpReportsError';
  }
}

/**
 * Reporte de liberaciones de Mercado Pago (`/v1/account/release_report`).
 * Cuenta global del sistema: credencial única (`MP_ACCESS_TOKEN`).
 */
export abstract class MercadoPagoReportsPort {
  /** Pide la generación del reporte (asíncrona). Devuelve el id si Mercado Pago lo informa. */
  abstract requestReport(request: MpReportRequest): Promise<MpReportRequested>;

  /** Los reportes de la cuenta. */
  abstract listReports(): Promise<MpReportRef[]>;

  /** El CSV de un reporte ya generado, como texto. */
  abstract downloadReport(fileName: string): Promise<string>;
}
