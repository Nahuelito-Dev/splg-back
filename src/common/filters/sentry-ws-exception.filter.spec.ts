import {
  ArgumentsHost,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import * as Sentry from '@sentry/nestjs';
import {
  iniciarSentryDePrueba,
  type SalidaDeSentry,
} from '../sentry/testing/sentry-de-prueba';
import { SentryWsExceptionFilter } from './sentry-ws-exception.filter';

describe('SentryWsExceptionFilter', () => {
  let salida: SalidaDeSentry;

  beforeAll(() => {
    salida = iniciarSentryDePrueba();
  });

  afterAll(async () => {
    await Sentry.close();
  });

  beforeEach(() => {
    salida.errores.length = 0;
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  const armar = (data: Record<string, unknown> = {}) => {
    const cliente = {
      emit: jest.fn(),
      nsp: { name: '/drivers' },
      data,
    };
    const host = {
      switchToWs: () => ({
        getClient: () => cliente,
        getData: () => ({}),
        getPattern: () => 'driver:join',
      }),
      getArgByIndex: (i: number) => (i === 0 ? cliente : {}),
      getArgs: () => [cliente, {}],
      getType: () => 'ws',
    } as unknown as ArgumentsHost;
    return { cliente, host };
  };

  it('un error no controlado va a Sentry con el usuario y la empresa, y el socket recibe lo de siempre', async () => {
    const { cliente, host } = armar({
      identidad: { userId: 'chofer-1', distributorId: 'dist-1' },
    });
    new SentryWsExceptionFilter().catch(new Error('redis caído'), host);
    await Sentry.flush(1000);

    expect(salida.errores).toHaveLength(1);
    expect(salida.errores[0].user).toEqual({ id: 'chofer-1' });
    expect(salida.errores[0].tags).toMatchObject({
      distributor: 'dist-1',
      socket_namespace: '/drivers',
    });
    expect(cliente.emit).toHaveBeenCalledWith(
      'exception',
      expect.objectContaining({
        status: 'error',
        message: 'Internal server error',
      }),
    );
  });

  it('sin identidad se manda igual, sin usuario', async () => {
    const { host } = armar();
    new SentryWsExceptionFilter().catch(
      new InternalServerErrorException(),
      host,
    );
    await Sentry.flush(1000);
    expect(salida.errores).toHaveLength(1);
    expect(salida.errores[0].user).toBeUndefined();
  });

  it.each([
    ['WsException', new WsException('sala inválida')],
    ['un 403', new ForbiddenException()],
  ])('%s es una respuesta esperada: no va a Sentry', async (_n, error) => {
    const { cliente, host } = armar();
    new SentryWsExceptionFilter().catch(error, host);
    await Sentry.flush(1000);
    expect(salida.errores).toHaveLength(0);
    expect(cliente.emit).toHaveBeenCalledWith('exception', expect.anything());
  });
});
