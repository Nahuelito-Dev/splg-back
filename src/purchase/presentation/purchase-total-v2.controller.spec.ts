import { PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { CompraInvalidaError } from '../domain/errors/purchase.errors';
import { PurchaseTotalV2Controller } from './purchase-total-v2.controller';

describe('total de una compra en la API v2', () => {
  const controller = new PurchaseTotalV2Controller();

  it('vive en `/purchase-orders` versión 2', () => {
    expect(
      Reflect.getMetadata(VERSION_METADATA, PurchaseTotalV2Controller),
    ).toBe('2');
    expect(Reflect.getMetadata(PATH_METADATA, PurchaseTotalV2Controller)).toBe(
      'purchase-orders',
    );
  });

  it('devuelve el subtotal de cada renglón y el total, con aritmética decimal', () => {
    const r = controller.previewTotal({
      items: [
        { quantity: 3, unitCost: 0.1 },
        { quantity: 40, unitCost: 5200.5 },
      ],
    });
    expect(r).toEqual({
      items: [{ subtotal: 0.3 }, { subtotal: 208020 }],
      total: 208020.3,
    });
  });

  it('sin renglones el total es 0', () => {
    expect(controller.previewTotal({ items: [] })).toEqual({
      items: [],
      total: 0,
    });
  });

  it('un total por encima del máximo (sólo alcanzable sin el tope de renglones del DTO) es un error de la compra', () => {
    expect(() =>
      controller.previewTotal({
        items: Array.from({ length: 30 }, () => ({
          quantity: 5000,
          unitCost: 90000,
        })),
      }),
    ).toThrow(CompraInvalidaError);
  });
});
