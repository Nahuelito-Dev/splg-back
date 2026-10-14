import { BadRequestException } from '@nestjs/common';
import { IDEMPOTENT_KEY } from '../../common/decorators/idempotent.decorator';
import { PurchaseReceiptController } from '../../purchase/presentation/purchase-receipt.controller';
import { CatalogStockController } from './catalog-stock.controller';
import { exigirIdempotencyKey } from './exigir-idempotency-key';
import { StockController } from './stock.controller';

describe('exigirIdempotencyKey', () => {
  it.each([undefined, '', '   '])(
    'sin clave (%p) es 400 y dice qué operación',
    (clave) => {
      expect(() => exigirIdempotencyKey(clave, 'La transferencia')).toThrow(
        BadRequestException,
      );
      expect(() => exigirIdempotencyKey(clave, 'La transferencia')).toThrow(
        /La transferencia exige el header Idempotency-Key/,
      );
    },
  );

  it('con clave no hace nada', () => {
    expect(() =>
      exigirIdempotencyKey('7f0a1c52-4b0e-4c43-9a3d-2f0f9c9c1d11', 'x'),
    ).not.toThrow();
  });
});

/** Un controller con sus dependencias de mentira: sólo importa que corte antes de ejecutar. */
const sinClave = (
  clase: new (...args: never[]) => object,
  metodo: string,
  args: unknown[],
  dependencias: Record<string, unknown> = {},
) => {
  const dep = new Proxy(dependencias, {
    get: (t, p: string) => t[p] ?? jest.fn(),
  });
  const instancia = new (clase as new (
    ...a: unknown[]
  ) => Record<string, (...a: unknown[]) => Promise<unknown>>)(
    ...Array<unknown>(12).fill(dep),
  );
  return instancia[metodo](...args);
};

describe('las escrituras de stock y compras exigen Idempotency-Key', () => {
  const casos: Array<
    [string, new (...args: never[]) => object, string, unknown[]]
  > = [
    ['POST /stock/transfers', StockController, 'transferir', [{}, 'd', 'u']],
    ['POST /stock/adjustments', StockController, 'ajustar', [{}, 'd', 'u']],
    [
      'POST /stock/initial-counts',
      StockController,
      'conteoInicial',
      [{}, 'd', 'u'],
    ],
    [
      'POST /stock/movements/batches/:id/reverse',
      StockController,
      'contraasentar',
      ['b', {}, 'd', 'u'],
    ],
    [
      'POST /stock/reconciliation/adjustments',
      StockController,
      'corregirVendible',
      [{}, 'd', 'u'],
    ],
    [
      'PATCH /gascylinder/:id/stock',
      CatalogStockController,
      'updateStock',
      ['g', {}, 'd', 'u'],
    ],
    [
      'POST /purchase-receipts',
      PurchaseReceiptController,
      'create',
      [{}, 'd', 'u'],
    ],
    [
      'PATCH /purchase-receipts/:id/void',
      PurchaseReceiptController,
      'void',
      ['r', {}, 'd', 'u'],
    ],
  ];

  it.each(casos)(
    '%s sin clave responde 400 antes de ejecutar',
    async (_ruta, clase, metodo, args) => {
      const ejecutar = jest.fn();
      await expect(
        sinClave(clase, metodo, args, {
          execute: ejecutar,
          recepcion: ejecutar,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(ejecutar).not.toHaveBeenCalled();
    },
  );

  it.each(casos)(
    '%s declara Idempotency-Key requerida en el OpenAPI',
    (_ruta, clase, metodo) => {
      const parametros = Reflect.getMetadata(
        'swagger/apiParameters',
        (clase.prototype as Record<string, object>)[metodo],
      ) as Array<{ name: string; in: string; required: boolean }> | undefined;
      expect(parametros).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
          }),
        ]),
      );
    },
  );

  it.each(casos)('%s sigue marcado @Idempotent', (_ruta, clase, metodo) => {
    expect(
      Reflect.getMetadata(
        IDEMPOTENT_KEY,
        (clase.prototype as Record<string, object>)[metodo],
      ),
    ).toBe(true);
  });
});
