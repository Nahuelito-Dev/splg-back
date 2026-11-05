import { AttachmentOwnerType } from '../attachment/entities/attachment.entity';
import { TipoDeDocumento } from '../document-reader/tipos-de-documento';
import {
  DOCUMENT_READING_OWNERS,
  ownersForMask,
} from './document-reading-owners';

describe('document-reading owners', () => {
  it.each([
    [
      1,
      AttachmentOwnerType.INSURANCE_INSTALLMENT,
      TipoDeDocumento.COMPROBANTE_DE_PAGO,
    ],
    [
      2,
      AttachmentOwnerType.TRAFFIC_FINE_PAYMENT,
      TipoDeDocumento.COMPROBANTE_DE_PAGO,
    ],
    [4, AttachmentOwnerType.CASH_MOVEMENT, TipoDeDocumento.COMPROBANTE_DE_PAGO],
    [8, AttachmentOwnerType.PURCHASE_RECEIPT, TipoDeDocumento.FACTURA_O_REMITO],
    [16, AttachmentOwnerType.INSURANCE_POLICY, TipoDeDocumento.POLIZA],
    [32, AttachmentOwnerType.EMPLOYEE, null],
    [64, AttachmentOwnerType.TRAFFIC_FINE, null],
    [
      128,
      AttachmentOwnerType.CUSTOMER_ACCOUNT_ENTRY,
      TipoDeDocumento.COMPROBANTE_DE_PAGO,
    ],
  ])('el bit %i corresponde a %s', (bit, ownerType, expectedType) => {
    expect(DOCUMENT_READING_OWNERS).toContainEqual({
      bit,
      ownerType,
      expectedType,
    });
  });

  it.each([
    [0, []],
    [1, [AttachmentOwnerType.INSURANCE_INSTALLMENT]],
    [255, DOCUMENT_READING_OWNERS.map((owner) => owner.ownerType)],
    [
      5,
      [
        AttachmentOwnerType.INSURANCE_INSTALLMENT,
        AttachmentOwnerType.CASH_MOVEMENT,
      ],
    ],
  ])('filtra la máscara %i', (mask, expected) => {
    expect(ownersForMask(mask).map((owner) => owner.ownerType)).toEqual(
      expected,
    );
  });

  it('tiene bits únicos y potencias de dos', () => {
    const bits = DOCUMENT_READING_OWNERS.map((owner) => owner.bit);
    expect(new Set(bits).size).toBe(bits.length);
    expect(bits.every((bit) => bit > 0 && (bit & (bit - 1)) === 0)).toBe(true);
  });
});
