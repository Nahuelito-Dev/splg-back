import { ArgumentsHost, HttpServer } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';
import { InvalidOrderTransitionError } from '../../order/domain/errors/invalid-order-transition.error';
import { GasCylinderNotFoundError } from '../../gascylinder/domain/errors/gas-cylinder-not-found.error';
import { InsufficientStockError } from '../../gascylinder/domain/errors/insufficient-stock.error';
import { InvalidCylinderTransitionError } from '../../cylinder/domain/errors/invalid-cylinder-transition.error';
import { OrderStatus } from '../../order/entities/order.entity';
import { CylinderState } from '../../cylinder/entities/cylinder.entity';

/**
 * P2-9: las state machines/stock ya NO lanzan `BadRequestException`/
 * `NotFoundException` de `@nestjs/common` sino errores de DOMINIO puros
 * (`domain/errors/`). Este filter es el ÚNICO responsable de traducirlos al
 * MISMO status HTTP que devolvía la API antes del refactor — si este test
 * pasa, la respuesta al cliente (Flutter/React) no cambió.
 */
describe('GlobalExceptionFilter — mapeo de errores de dominio (P2-9)', () => {
  let filter: GlobalExceptionFilter;
  let applicationRef: {
    isHeadersSent: jest.Mock;
    reply: jest.Mock;
    end: jest.Mock;
  };
  let host: ArgumentsHost;

  const makeHost = (): ArgumentsHost => {
    const request = { method: 'PATCH', url: '/orders/ord-1/status' };
    const response = {};
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
      getArgByIndex: (i: number) => (i === 1 ? response : request),
    } as unknown as ArgumentsHost;
  };

  beforeEach(() => {
    applicationRef = {
      isHeadersSent: jest.fn().mockReturnValue(false),
      reply: jest.fn(),
      end: jest.fn(),
    };
    filter = new GlobalExceptionFilter(applicationRef as unknown as HttpServer);
    host = makeHost();
  });

  it.each(['55P03', '57014'])(
    'un error de base %s (lock/statement timeout) responde 503 en castellano',
    (code) => {
      // QueryFailedError de TypeORM: el SQLSTATE puede venir en driverError.
      filter.catch(
        Object.assign(new Error('canceling statement'), {
          driverError: { code },
        }),
        host,
      );

      expect(applicationRef.reply).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          statusCode: 503,
          message: 'El sistema está ocupado, reintentá en unos segundos',
        }),
        503,
      );
    },
  );

  it.each(['22021', '22P05'])(
    'un texto que la base no puede guardar (%s, p. ej. NUL) responde 400 en castellano',
    (code) => {
      filter.catch(
        Object.assign(new Error('invalid byte sequence for encoding "UTF8"'), {
          driverError: { code },
        }),
        host,
      );

      expect(applicationRef.reply).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          statusCode: 400,
          message:
            'Alguno de los textos enviados tiene caracteres no válidos (por ejemplo el carácter nulo)',
        }),
        400,
      );
    },
  );

  it('mapea InvalidOrderTransitionError a 400 con el mismo mensaje', () => {
    const error = new InvalidOrderTransitionError(
      OrderStatus.PENDING,
      OrderStatus.DELIVERED,
    );

    filter.catch(error, host);

    expect(applicationRef.reply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        statusCode: 400,
        message: 'Transición de pedido inválida: pending → delivered',
      }),
      400,
    );
  });

  it('mapea InvalidCylinderTransitionError a 400', () => {
    const error = new InvalidCylinderTransitionError(
      CylinderState.IN_DEPOT,
      CylinderState.WITH_CUSTOMER,
    );

    filter.catch(error, host);

    expect(applicationRef.reply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ statusCode: 400 }),
      400,
    );
  });

  it('mapea InsufficientStockError a 400', () => {
    const error = new InsufficientStockError('Garrafa 10kg');

    filter.catch(error, host);

    expect(applicationRef.reply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        statusCode: 400,
        message: 'Stock insuficiente para Garrafa 10kg',
      }),
      400,
    );
  });

  it('mapea GasCylinderNotFoundError a 404', () => {
    const error = new GasCylinderNotFoundError('gc-x');

    filter.catch(error, host);

    expect(applicationRef.reply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        statusCode: 404,
        message: 'Garrafa no encontrada: gc-x',
      }),
      404,
    );
  });
});
