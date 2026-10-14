import type { ExecutionContext } from '@nestjs/common';
import {
  AppThrottlerGuard,
  THROTTLER_SUBIDAS,
  esRutaDeSubida,
} from './app-throttler.guard';

const contexto = (
  metodo: string,
  contentType?: string,
  tipo = 'http',
): ExecutionContext =>
  ({
    getType: () => tipo,
    switchToHttp: () => ({
      getRequest: () => ({
        method: metodo,
        headers: contentType ? { 'content-type': contentType } : {},
      }),
    }),
  }) as unknown as ExecutionContext;

describe('esRutaDeSubida', () => {
  it.each(['POST', 'PUT', 'PATCH'])('%s multipart es una subida', (m) => {
    expect(esRutaDeSubida(contexto(m, 'multipart/form-data; boundary=x'))).toBe(
      true,
    );
  });

  it('un JSON, un GET o un contexto que no es HTTP no lo son', () => {
    expect(esRutaDeSubida(contexto('POST', 'application/json'))).toBe(false);
    expect(esRutaDeSubida(contexto('GET', 'multipart/form-data'))).toBe(false);
    expect(esRutaDeSubida(contexto('POST'))).toBe(false);
    expect(esRutaDeSubida(contexto('PUT', 'multipart/form-data', 'ws'))).toBe(
      false,
    );
  });
});

describe('AppThrottlerGuard · cupo de subidas', () => {
  class Visible extends AppThrottlerGuard {
    clave(c: ExecutionContext, sufijo: string, nombre: string) {
      return this.generateKey(c, sufijo, nombre);
    }
  }
  const guard = Object.create(Visible.prototype) as Visible;

  it('el cupo de subidas es por sesión, el mismo en todas las rutas', () => {
    const a = guard.clave(contexto('PUT'), 'sesion:abc', THROTTLER_SUBIDAS);
    const b = guard.clave(contexto('POST'), 'sesion:abc', THROTTLER_SUBIDAS);
    const otra = guard.clave(contexto('PUT'), 'sesion:xyz', THROTTLER_SUBIDAS);
    expect(a).toBe(b);
    expect(a).not.toBe(otra);
  });
});
