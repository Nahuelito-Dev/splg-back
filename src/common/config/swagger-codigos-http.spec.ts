import { ParseUUIDPipe, Type, VersioningType } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { INestApplication } from '@nestjs/common';
import { VERSION_NEUTRAL } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { CoverageZoneController } from '../../coverage-zone/coverage-zone.controller';
import { EmployeeController } from '../../employee/employee.controller';
import { FleetTaskController } from '../../fleet/fleet-task.controller';
import { FleetTaskV2Controller } from '../../fleet/fleet-task-v2.controller';
import { DeliveryCodeV2Controller } from '../../order/delivery-code-v2.controller';
import { OrderController } from '../../order/order.controller';
import { ProcessRunController } from '../../process-run/process-run.controller';
import { RepurchaseAdminController } from '../../repurchase-forecast/repurchase-admin.controller';
import { RepurchaseCustomerController } from '../../repurchase-forecast/repurchase-customer.controller';
import { UsersController } from '../../users/users.controller';
import { soloRutasVersionadas } from './documentacion';

/**
 * Los códigos HTTP que la API devuelve de verdad (matriz del 03/11) tienen que
 * estar en el documento de Swagger. El documento se genera con los controllers
 * reales, sin base ni servicios.
 */
const CONTROLLERS: Type<unknown>[] = [
  FleetTaskController,
  FleetTaskV2Controller,
  RepurchaseCustomerController,
  RepurchaseAdminController,
  DeliveryCodeV2Controller,
  OrderController,
  UsersController,
  EmployeeController,
  CoverageZoneController,
  ProcessRunController,
];

type Operacion = { responses?: Record<string, { description?: string }> };

describe('Swagger: códigos HTTP documentados', () => {
  let app: INestApplication;
  let documento: OpenAPIObject;

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({ controllers: CONTROLLERS })
      .useMocker(() => ({}))
      .compile();
    app = modulo.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    documento = soloRutasVersionadas(
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('t').build(),
      ),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  const respuestas = (
    metodo: 'get' | 'post' | 'patch' | 'delete',
    ruta: string,
  ): Record<string, { description?: string }> => {
    const operacion = (
      documento.paths[ruta] as Record<string, Operacion> | undefined
    )?.[metodo];
    if (!operacion) throw new Error(`Swagger no lista ${metodo} ${ruta}`);
    return operacion.responses ?? {};
  };

  it('POST /fleet/tasks declara el 409 del empleado egresado', () => {
    const r = respuestas('post', '/api/v1/fleet/tasks');
    expect(r['409']?.description).toMatch(/egresado/);
  });

  it('PATCH /fleet/tasks/{id}: el 400 son las validaciones y el 409 la tarea cerrada', () => {
    const r = respuestas('patch', '/api/v1/fleet/tasks/{id}');
    expect(r['400']?.description).toMatch(/UUID/);
    expect(r['400']?.description).toMatch(/fecha irreal/);
    expect(r['400']?.description).not.toMatch(/hecha o cancelada/);
    expect(r['409']?.description).toMatch(/hecha o cancelada/);
  });

  it.each([
    ['get', '/api/v2/customers/me/repurchase/invitations/{id}'],
    ['post', '/api/v2/customers/me/repurchase/invitations/{id}/accept'],
    ['post', '/api/v2/customers/me/repurchase/invitations/{id}/dismiss'],
    ['post', '/api/v2/orders/{id}/delivery-code/regenerate'],
    ['delete', '/api/v1/users/{id}'],
  ] as const)('%s %s declara el 400 por id que no es UUID', (metodo, ruta) => {
    expect(respuestas(metodo, ruta)['400']?.description).toMatch(/UUID/);
  });

  it('DELETE /users/{id}: el 409 menciona la rendición pendiente del chofer', () => {
    const r = respuestas('delete', '/api/v1/users/{id}');
    expect(r['409']?.description).toMatch(/rendición pendiente/);
  });

  it.each(['/api/v2/process-runs', '/api/v2/process-runs/summary'])(
    'GET %s declara 401 y 403 (cliente y chofer)',
    (ruta) => {
      const r = respuestas('get', ruta);
      expect(r['200']).toBeDefined();
      expect(r['401']).toBeDefined();
      expect(r['403']?.description).toMatch(/admin/);
    },
  );

  it('GET /process-runs declara el 400 de cada filtro', () => {
    const r = respuestas('get', '/api/v2/process-runs');
    expect(r['400']?.description).toMatch(/process/);
    expect(r['400']?.description).toMatch(/status/);
    expect(r['400']?.description).toMatch(/from/);
    expect(r['400']?.description).toMatch(/limit/);
  });

  it('todo endpoint con ParseUUIDPipe de esos controllers declara su 400', () => {
    const sinBadRequest: string[] = [];
    for (const controller of CONTROLLERS) {
      for (const nombre of Object.getOwnPropertyNames(controller.prototype)) {
        if (nombre === 'constructor') continue;
        const args = Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          controller,
          nombre,
        ) as Record<string, { pipes?: unknown[] }> | undefined;
        const usaParseUuid = Object.values(args ?? {}).some((a) =>
          a.pipes?.some((p) => p === ParseUUIDPipe),
        );
        if (!usaParseUuid) continue;
        const respuestasDelMetodo = Reflect.getMetadata(
          'swagger/apiResponse',
          (controller.prototype as Record<string, object>)[nombre],
        ) as Record<string, unknown> | undefined;
        if (!respuestasDelMetodo?.['400']) {
          sinBadRequest.push(`${controller.name}.${nombre}`);
        }
      }
    }
    expect(sinBadRequest).toEqual([]);
  });
});
