import { AttachmentOwnerType } from '../attachment/entities/attachment.entity';
import { TipoDeDocumento } from '../document-reader/tipos-de-documento';

export interface DocumentReadingOwner {
  bit: number;
  ownerType: AttachmentOwnerType;
  expectedType: TipoDeDocumento | null;
}

export const DOCUMENT_READING_OWNERS: readonly DocumentReadingOwner[] = [
  {
    bit: 1,
    ownerType: AttachmentOwnerType.INSURANCE_INSTALLMENT,
    expectedType: TipoDeDocumento.COMPROBANTE_DE_PAGO,
  },
  {
    bit: 2,
    ownerType: AttachmentOwnerType.TRAFFIC_FINE_PAYMENT,
    expectedType: TipoDeDocumento.COMPROBANTE_DE_PAGO,
  },
  {
    bit: 4,
    ownerType: AttachmentOwnerType.CASH_MOVEMENT,
    expectedType: TipoDeDocumento.COMPROBANTE_DE_PAGO,
  },
  {
    bit: 8,
    ownerType: AttachmentOwnerType.PURCHASE_RECEIPT,
    expectedType: TipoDeDocumento.FACTURA_O_REMITO,
  },
  {
    bit: 16,
    ownerType: AttachmentOwnerType.INSURANCE_POLICY,
    expectedType: TipoDeDocumento.POLIZA,
  },
  { bit: 32, ownerType: AttachmentOwnerType.EMPLOYEE, expectedType: null },
  { bit: 64, ownerType: AttachmentOwnerType.TRAFFIC_FINE, expectedType: null },
  {
    bit: 128,
    ownerType: AttachmentOwnerType.CUSTOMER_ACCOUNT_ENTRY,
    expectedType: TipoDeDocumento.COMPROBANTE_DE_PAGO,
  },
];

export function ownersForMask(mask: number): DocumentReadingOwner[] {
  return DOCUMENT_READING_OWNERS.filter((owner) => (mask & owner.bit) !== 0);
}
