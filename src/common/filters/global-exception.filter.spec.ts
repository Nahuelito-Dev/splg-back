import {
  ArgumentsHost,
  BadRequestException,
  HttpServer,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';
import { InvalidOrderTransitionError } from '../../order/domain/errors/invalid-order-transition.error';
import { GasCylinderNotFoundError } from '../../gascylinder/domain/errors/gas-cylinder-not-found.error';
import { InsufficientStockError } from '../../gascylinder/domain/errors/insufficient-stock.error';
import { InvalidCylinderTransitionError } from '../../cylinder/domain/errors/invalid-cylinder-transition.error';
import {
  InvalidRouteInputError,
  MissingStopLoadError,
} from '../../route-batch/domain/errors/route-sheet.errors';
import { OrderStatus } from '../../order/entities/order.entity';
import { CylinderState } from '../../cylinder/entities/cylinder.entity';
import {
  SesionNoPendienteError,
  DuracionInvalidaError,
} from '../../support/domain/support-session.errors';

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

  it.each([
    [
      'datos de ruteo inválidos',
      new InvalidRouteInputError('el pedido ord-123 está repetido'),
    ],
    ['carga faltante', new MissingStopLoadError('ord-123')],
  ])(
    '%s es una falla interna: 500 genérico, sin el detalle ni los ids en la respuesta',
    (_nombre, error) => {
      filter.catch(error, host);
      expect(applicationRef.reply).toHaveBeenCalledTimes(1);
      const [, cuerpo, status] = applicationRef.reply.mock.calls[0] as [
        unknown,
        { statusCode: number; message: string },
        number,
      ];
      expect(status).toBe(500);
      expect(cuerpo.statusCode).toBe(500);
      expect(cuerpo.message).toBe('Error interno del servidor');
      expect(JSON.stringify(cuerpo)).not.toContain('ord-123');
    },
  );

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

  it.each([
    ['23514', 'CHK_order_cancelado_motivo', 400, 'indicar el motivo'],
    ['23505', 'UQ_time_slot_nombre_activa', 409, 'franja con ese nombre'],
    ['23P01', 'EXC_time_slot_solapada', 409, 'se solapa con otra franja'],
  ])(
    'una regla de la base (%s %s) que ningún servicio tradujo sale como %i con su motivo',
    (code, constraint, status, parte) => {
      filter.catch(
        Object.assign(new Error('violates constraint'), { code, constraint }),
        host,
      );

      expect(applicationRef.reply).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          statusCode: status,
          message: expect.stringContaining(parte) as string,
        }),
        status,
      );
    },
  );

  it('una violación de una restricción que no conocemos sigue siendo 500', () => {
    filter.catch(
      Object.assign(new Error('violates'), {
        code: '23514',
        constraint: 'CHK_desconocida',
      }),
      host,
    );
    expect(applicationRef.reply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ statusCode: 500 }),
      500,
    );
  });

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
        message: 'Garrafa no encontrada',
      }),
      404,
    );
  });

  it('un error de dominio con code lo lleva a la respuesta (409)', () => {
    filter.catch(new SesionNoPendienteError(), host);
    expect(applicationRef.reply).toHaveBeenCalledWith(
      expect.anything(),
      {
        statusCode: 409,
        message: 'La solicitud de soporte ya no está pendiente',
        error: 'Conflicto',
        code: 'SUPPORT_SESSION_NOT_PENDING',
      },
      409,
    );
  });

  it('un error de dominio sin code sale como siempre (sin code)', () => {
    filter.catch(new DuracionInvalidaError('Duración mal'), host);
    const [, cuerpo] = applicationRef.reply.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(cuerpo).toMatchObject({ statusCode: 400, message: 'Duración mal' });
    expect(cuerpo).not.toHaveProperty('code');
  });

  it('una escritura en una transacción de sólo lectura (25006, modo soporte) es 403 SUPPORT_READ_ONLY', () => {
    filter.catch(
      Object.assign(
        new Error('cannot execute UPDATE in a read-only transaction'),
        {
          driverError: { code: '25006' },
        },
      ),
      host,
    );
    expect(applicationRef.reply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        statusCode: 403,
        code: 'SUPPORT_READ_ONLY',
        message: 'Estás en modo soporte: es sólo lectura',
      }),
      403,
    );
  });

  it('el id de un error de dominio va al log y no a la respuesta', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    filter.catch(new GasCylinderNotFoundError('gc-secreto'), host);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('gasCylinderId=gc-secreto'),
    );
    expect(JSON.stringify(applicationRef.reply.mock.calls)).not.toContain(
      'gc-secreto',
    );
    warn.mockRestore();
  });

  it('traduce el 400 de un Parse*Pipe y el 404 de ruta inexistente, con su status', () => {
    filter.catch(
      new BadRequestException('Validation failed (uuid is expected)'),
      host,
    );
    expect(applicationRef.reply).toHaveBeenLastCalledWith(
      expect.anything(),
      {
        statusCode: 400,
        error: 'Solicitud inválida',
        code: 'INVALID_ID',
        message: 'El identificador no es válido',
      },
      400,
    );

    filter.catch(new NotFoundException('Cannot GET /api/v1/nada'), host);
    expect(applicationRef.reply).toHaveBeenLastCalledWith(
      expect.anything(),
      {
        statusCode: 404,
        error: 'No encontrado',
        message: 'No existe la ruta GET /api/v1/nada',
      },
      404,
    );
  });
});
