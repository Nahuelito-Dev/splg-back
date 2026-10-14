import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { traducirErrorDeCompra } from './traducir-error-de-compra';

const logger = new Logger('test');

describe('traducirErrorDeCompra', () => {
  it('un texto más largo que la columna (22001) es 400, no 500', () => {
    const error = Object.assign(new Error('value too long'), {
      driverError: { code: '22001' },
    });
    expect(() =>
      traducirErrorDeCompra(error, logger, 'anulación de recepción'),
    ).toThrow(BadRequestException);
    expect(() =>
      traducirErrorDeCompra(error, logger, 'anulación de recepción'),
    ).toThrow(/textos enviados es demasiado largo/);
  });

  it('el documento repetido del proveedor es 409', () => {
    const error = Object.assign(new Error('dup'), {
      driverError: {
        code: '23505',
        constraint: 'UQ_purchase_receipt_documento_proveedor',
      },
    });
    expect(() => traducirErrorDeCompra(error, logger, 'x')).toThrow(
      ConflictException,
    );
  });

  it('lo que no es de base pasa tal cual', () => {
    const error = new BadRequestException('x');
    expect(() => traducirErrorDeCompra(error, logger, 'x')).toThrow(error);
  });
});
