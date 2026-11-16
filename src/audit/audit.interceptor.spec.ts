import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  NotFoundException,
} from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { AuditInterceptor } from './audit.interceptor';
import { SoloLectura } from './solo-lectura.decorator';
import { AuditService, NuevoAsiento } from './audit.service';
import { AuditResult } from './entities/audit-log.entity';
import { RoleType } from '../common/constants/role-type.enum';

describe('AuditInterceptor (CU-153)', () => {
  let registrar: jest.Mock;
  let interceptor: AuditInterceptor;

  const contexto = (
    method: string,
    extra: Record<string, unknown> = {},
    handlerFn: () => void = () => undefined,
  ) => {
    const request = {
      method,
      path: '/api/orders/o1/status',
      route: { path: '/api/orders/:id/status' },
      params: { id: 'o1' },
      body: { status: 'accepted', password: 'x' },
      headers: { 'x-client-source': 'panel-app' },
      ip: '10.0.0.1',
      user: { user_id: 'u1', email: 'a@splg.com', role: RoleType.ADMIN },
      distributorId: 'd1',
      ...extra,
    };
    return {
      getType: () => 'http',
      getHandler: () => handlerFn,
      getClass: () => class Controlador {},
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ statusCode: 200 }),
      }),
    } as unknown as ExecutionContext;
  };
  const handler = (resultado: unknown): CallHandler => ({
    handle: () => of(resultado),
  });
  const asiento = (): NuevoAsiento =>
    (registrar.mock.calls[0] as [NuevoAsiento])[0];

  beforeEach(() => {
    registrar = jest.fn().mockResolvedValue(undefined);
    interceptor = new AuditInterceptor(
      { registrar } as unknown as AuditService,
      new Reflector(),
    );
  });

  it('no registra un POST marcado @SoloLectura, y sí uno igual sin la marca', async () => {
    class Controlador {
      @SoloLectura()
      consulta() {
        return undefined;
      }
      escritura() {
        return undefined;
      }
    }
    const metodo = (nombre: string) =>
      Object.getOwnPropertyDescriptor(Controlador.prototype, nombre)
        ?.value as () => void;
    await lastValueFrom(
      interceptor.intercept(
        contexto('POST', {}, metodo('consulta')),
        handler({}),
      ),
    );
    expect(registrar).not.toHaveBeenCalled();
    await lastValueFrom(
      interceptor.intercept(
        contexto('POST', {}, metodo('escritura')),
        handler({}),
      ),
    );
    expect(registrar).toHaveBeenCalledTimes(1);
  });

  it('registra una escritura exitosa con quién, sobre qué y desde dónde', async () => {
    await lastValueFrom(interceptor.intercept(contexto('PATCH'), handler({})));
    expect(asiento()).toMatchObject({
      distributorId: 'd1',
      actorUserId: 'u1',
      actorRole: RoleType.ADMIN,
      httpMethod: 'PATCH',
      resource: 'orders',
      resourceId: 'o1',
      path: '/api/orders/:id/status',
      clientSource: 'panel-app',
      ip: '10.0.0.1',
      result: AuditResult.SUCCESS,
      statusCode: 200,
      changes: { status: 'accepted', password: '[depurado]' },
      errorMessage: null,
    });
  });

  it('guarda el request id del pedido para unirlo con su traza (monitor O1)', async () => {
    await lastValueFrom(
      interceptor.intercept(
        contexto('PATCH', { requestId: 'prueba-o1' }),
        handler({}),
      ),
    );
    expect(asiento().requestId).toBe('prueba-o1');
  });

  it('sin request id (fuera del middleware) el asiento queda sin traza', async () => {
    await lastValueFrom(interceptor.intercept(contexto('PATCH'), handler({})));
    expect(asiento().requestId).toBeNull();
  });

  it.each([
    ['/api/v1/orders/:id/status', 'orders'],
    ['/api/v2/insurance-policies/:id/cancel', 'insurance-policies'],
    ['/api/orders/:id/status', 'orders'],
  ])(
    'el recurso de %s es %s, sin el número de versión',
    async (ruta, recurso) => {
      await lastValueFrom(
        interceptor.intercept(
          contexto('PATCH', { route: { path: ruta } }),
          handler({}),
        ),
      );
      expect(asiento()).toMatchObject({ resource: recurso, path: ruta });
    },
  );

  it('registra la operación rechazada con su código y motivo, y no se come el error', async () => {
    const error = new NotFoundException('Order not found');
    await expect(
      lastValueFrom(
        interceptor.intercept(contexto('DELETE'), {
          handle: () => throwError(() => error),
        }),
      ),
    ).rejects.toBe(error);
    expect(asiento()).toMatchObject({
      result: AuditResult.FAILURE,
      statusCode: 404,
      errorMessage: 'Order not found',
    });
  });

  it('una validación rechazada guarda los mensajes de cada campo', async () => {
    const error = new BadRequestException([
      'quantity debe ser un número entero',
      'quantity fuera de rango',
    ]);
    await expect(
      lastValueFrom(
        interceptor.intercept(contexto('PATCH'), {
          handle: () => throwError(() => error),
        }),
      ),
    ).rejects.toBe(error);
    expect(asiento().errorMessage).toBe(
      'quantity debe ser un número entero; quantity fuera de rango',
    );
  });

  it('el motivo queda en castellano, el mismo que recibe el cliente (id mal formado)', async () => {
    const error = new BadRequestException(
      'Validation failed (uuid is expected)',
    );
    await expect(
      lastValueFrom(
        interceptor.intercept(contexto('PATCH'), {
          handle: () => throwError(() => error),
        }),
      ),
    ).rejects.toBe(error);
    expect(asiento()).toMatchObject({
      statusCode: 400,
      errorMessage: 'El identificador no es válido',
    });
  });

  it('las lecturas no se registran', async () => {
    await lastValueFrom(interceptor.intercept(contexto('GET'), handler([])));
    expect(registrar).not.toHaveBeenCalled();
  });

  it('una operación sin sesión (alta pública, login) queda sin autor', async () => {
    await lastValueFrom(
      interceptor.intercept(
        contexto('POST', { user: undefined, distributorId: undefined }),
        handler({}),
      ),
    );
    expect(asiento()).toMatchObject({
      actorUserId: null,
      actorRole: null,
      distributorId: null,
    });
  });
});
