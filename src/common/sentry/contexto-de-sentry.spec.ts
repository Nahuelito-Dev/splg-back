import { ExecutionContext } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { Request } from 'express';
import { lastValueFrom, of } from 'rxjs';
import { aplicarContextoDeRequest } from './contexto-de-sentry';
import { ContextoDeSentryInterceptor } from './contexto-de-sentry.interceptor';
import { esErrorParaSentry, reportarErrorDeRequest } from './reportar-a-sentry';
import {
  iniciarSentryDePrueba,
  type SalidaDeSentry,
} from './testing/sentry-de-prueba';

// El SDK real (sin salir a la red): sin cliente, el scope de aislamiento no se separa por request.
let salida: SalidaDeSentry;

beforeAll(() => {
  salida = iniciarSentryDePrueba();
});

afterAll(async () => {
  await Sentry.close();
});

function request(datos: Partial<Request>): Request {
  return { headers: {}, ...datos } as Request;
}

describe('contexto de Sentry por request', () => {
  it('pone el user_id (sin correo ni nombre), la empresa resuelta, el cliente y el request id', () => {
    const scope = new Sentry.Scope();
    aplicarContextoDeRequest(
      scope,
      request({
        requestId: 'req-1',
        distributorId: 'dist-resuelta',
        headers: {
          'x-client-source': ' app-cliente ',
          'x-distributor': 'la-que-manda-el-cliente',
        },
        user: {
          user_id: 'user-1',
          email: 'ana@example.com',
          role: 'customer' as never,
          distributor_id: 'otra',
        },
      }),
    );
    const datos = scope.getScopeData();
    expect(datos.user).toEqual({ id: 'user-1' });
    expect(datos.tags).toEqual({
      distributor: 'dist-resuelta',
      client_source: 'app-cliente',
      request_id: 'req-1',
    });
  });

  it('sin empresa en la request usa la del usuario; sin request id usa el encabezado', () => {
    const scope = new Sentry.Scope();
    aplicarContextoDeRequest(
      scope,
      request({
        headers: { 'x-request-id': 'del-header' },
        user: {
          user_id: 'user-2',
          email: 'x@y.co',
          role: 'admin' as never,
          distributor_id: 'dist-del-usuario',
        },
      }),
    );
    expect(scope.getScopeData().tags).toEqual({
      distributor: 'dist-del-usuario',
      request_id: 'del-header',
    });
  });

  it('una request anónima no pone nada', () => {
    const scope = new Sentry.Scope();
    aplicarContextoDeRequest(
      scope,
      request({ headers: { 'x-client-source': '' } }),
    );
    expect(scope.getScopeData().user).toEqual({});
    expect(scope.getScopeData().tags).toEqual({});
  });

  describe('ContextoDeSentryInterceptor', () => {
    const contexto = (tipo: string, req: Request): ExecutionContext =>
      ({
        getType: () => tipo,
        switchToHttp: () => ({ getRequest: () => req }),
      }) as unknown as ExecutionContext;

    it('en HTTP pone el contexto en el scope de la request y sigue', async () => {
      const interceptor = new ContextoDeSentryInterceptor();
      const tags = await Sentry.withIsolationScope(async (scope) => {
        const salida = interceptor.intercept(
          contexto('http', request({ requestId: 'req-9' })),
          { handle: () => of('respuesta') },
        );
        await expect(lastValueFrom(salida)).resolves.toBe('respuesta');
        return scope.getScopeData().tags;
      });
      expect(tags).toEqual({ request_id: 'req-9' });
    });

    it('fuera de HTTP (sockets) no toca nada', async () => {
      const interceptor = new ContextoDeSentryInterceptor();
      const tags = await Sentry.withIsolationScope(async (scope) => {
        const salida = interceptor.intercept(
          contexto('ws', request({ requestId: 'req-9' })),
          { handle: () => of('ok') },
        );
        await expect(lastValueFrom(salida)).resolves.toBe('ok');
        return scope.getScopeData().tags;
      });
      expect(tags).toEqual({});
    });
  });
});

describe('reportar a Sentry', () => {
  it.each([
    [400, false],
    [404, false],
    [429, false],
    [499, false],
    [500, true],
    [503, true],
  ])('status %s → a Sentry: %s', (status, esperado) => {
    expect(esErrorParaSentry(status)).toBe(esperado);
  });

  it('un error de request sin request se manda igual, sin contexto', async () => {
    reportarErrorDeRequest(new Error('sin request'), undefined);
    await Sentry.flush(1000);
    expect(salida.errores).toHaveLength(1);
    expect(salida.errores[0].exception?.values?.[0].value).toBe('sin request');
  });
});
