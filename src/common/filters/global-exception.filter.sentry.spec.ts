import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpServer,
  HttpStatus,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import {
  iniciarSentryDePrueba,
  type SalidaDeSentry,
} from '../sentry/testing/sentry-de-prueba';
import { GlobalExceptionFilter } from './global-exception.filter';

/**
 * Con el SDK real (un cliente de Sentry que no sale a la red): qué errores de
 * request llegan a Sentry y con qué contexto. Sólo los 5xx.
 */
describe('GlobalExceptionFilter → Sentry', () => {
  let salida: SalidaDeSentry;
  let filter: GlobalExceptionFilter;

  beforeAll(() => {
    salida = iniciarSentryDePrueba();
  });

  afterAll(async () => {
    await Sentry.close();
  });

  beforeEach(() => {
    salida.errores.length = 0;
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    filter = new GlobalExceptionFilter({
      isHeadersSent: jest.fn().mockReturnValue(false),
      reply: jest.fn(),
      end: jest.fn(),
    } as unknown as HttpServer);
  });

  const host = (): ArgumentsHost => {
    const request = {
      method: 'POST',
      url: '/api/v1/orders',
      requestId: 'req-123',
      distributorId: 'dist-1',
      headers: {
        'x-client-source': 'panel',
        authorization: 'Bearer secreto',
      },
      user: {
        user_id: 'user-1',
        email: 'ana@example.com',
        role: 'admin',
        distributor_id: 'dist-1',
      },
    };
    const response = {};
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
      getArgByIndex: (i: number) => (i === 1 ? response : request),
    } as unknown as ArgumentsHost;
  };

  it.each([
    ['400', new BadRequestException('dato inválido')],
    ['401', new UnauthorizedException()],
    ['403', new ForbiddenException()],
    ['404', new NotFoundException()],
    ['409', new ConflictException()],
    ['429', new HttpException('muchas', HttpStatus.TOO_MANY_REQUESTS)],
  ])('un %s no se manda', async (_status, error) => {
    filter.catch(error, host());
    await Sentry.flush(1000);
    expect(salida.errores).toHaveLength(0);
  });

  it('un error no controlado (500) se manda con usuario, empresa, cliente y request id', async () => {
    filter.catch(new Error('se rompió algo para ana@example.com'), host());
    await Sentry.flush(1000);
    expect(salida.errores).toHaveLength(1);
    const [evento] = salida.errores;
    expect(evento.exception?.values?.[0]).toMatchObject({
      type: 'Error',
      value: 'se rompió algo para [Filtered]',
    });
    expect(evento.exception?.values?.[0].mechanism).toMatchObject({
      handled: false,
    });
    expect(evento.user).toEqual({ id: 'user-1' });
    expect(evento.tags).toMatchObject({
      distributor: 'dist-1',
      client_source: 'panel',
      request_id: 'req-123',
    });
    expect(evento.environment).toBe('test');
    expect(evento.release).toBe('splg-server@1.0.0');
  });

  it('un timeout de la base (503) se manda con el error original, no con la traducción', async () => {
    filter.catch(
      Object.assign(new Error('canceling statement due to lock timeout'), {
        code: '55P03',
      }),
      host(),
    );
    await Sentry.flush(1000);
    expect(salida.errores).toHaveLength(1);
    expect(salida.errores[0].exception?.values?.[0].value).toBe(
      'canceling statement due to lock timeout',
    );
  });

  it('un 503 también se manda', async () => {
    filter.catch(new ServiceUnavailableException('proveedor caído'), host());
    await Sentry.flush(1000);
    expect(salida.errores).toHaveLength(1);
    expect(salida.errores[0].exception?.values?.[0].value).toBe(
      'proveedor caído',
    );
  });
});
