export enum SupplierKind {
  /** Planta fraccionadora: la que llena las garrafas y canjea los envases. */
  FILLING_PLANT = 'filling_plant',
  OTHER = 'other',
}

export enum PurchaseOrderStatus {
  DRAFT = 'draft',
  SENT = 'sent',
  PARTIALLY_RECEIVED = 'partially_received',
  RECEIVED = 'received',
  /** Cerrada con faltante: se recibió parte y el resto ya no llega. */
  CLOSED_SHORT = 'closed_short',
  CANCELLED = 'cancelled',
}

export enum SupplierDocumentType {
  DELIVERY_NOTE = 'delivery_note',
  INVOICE = 'invoice',
}

export enum PaymentStatus {
  UNPAID = 'unpaid',
  PAID = 'paid',
}

export enum PurchaseReceiptStatus {
  CONFIRMED = 'confirmed',
  VOIDED = 'voided',
}
