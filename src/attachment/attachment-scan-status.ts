/**
 * Estado del escaneo antivirus de un adjunto (diseño de comunicación §9.3).
 * `not_required` es el de los adjuntos de siempre (no pasan por el escáner);
 * los del chat nacen `clean` (fotos: las re-codifica `sharp`) o `pending`
 * (PDF y Office), y el escáner los pasa a `clean`, `infected` o `failed`.
 * Las transiciones las controla también la base (`TRG_attachment_escaneo`).
 */
export enum AttachmentScanStatus {
  NOT_REQUIRED = 'not_required',
  PENDING = 'pending',
  CLEAN = 'clean',
  INFECTED = 'infected',
  FAILED = 'failed',
}
