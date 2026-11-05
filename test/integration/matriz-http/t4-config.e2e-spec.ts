import { createTestApp, TestEnv } from '../setup/test-env';
import {
  Caso,
  correrMatriz,
  endpoint,
  llamar,
  reiniciarCuposDelThrottler,
} from './matriz';
import { EscenarioT4, sembrarBaseT4 } from './t4-base';

describe('Matriz HTTP T4: configuración (e2e)', () => {
  let env: TestEnv;
  let ctx: EscenarioT4;
  const ver = () => ctx;
  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    ctx = {
      ...(await sembrarBaseT4(env.app)),
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
  }, 240000);
  afterAll(async () => env.cleanup());

  const config = (method: 'get' | 'put', path: string) =>
    endpoint<EscenarioT4>(
      method,
      `/module-config/${path}`,
      `/module-config/${path}`,
    );
  const dispatch = config('get', 'dispatch');
  const putDispatch = config('put', 'dispatch');
  const express = config('get', 'express_dispatch');
  const putExpress = config('put', 'express_dispatch');
  const processes = config('get', 'processes');
  const getProcess = endpoint<EscenarioT4>(
    'get',
    '/module-config/{process}',
    '/module-config/repurchase',
  );
  const putProcess = endpoint<EscenarioT4>(
    'put',
    '/module-config/{process}',
    '/module-config/repurchase',
  );
  const tasks = config('get', 'scheduled_tasks');
  const putTasks = config('put', 'scheduled_tasks');
  const surcharge = endpoint<EscenarioT4>(
    'get',
    '/v2/payment-surcharges',
    '/v2/payment-surcharges',
  );
  const putSurcharge = endpoint<EscenarioT4>(
    'put',
    '/v2/payment-surcharges',
    '/v2/payment-surcharges',
  );
  const casos: Array<Caso<EscenarioT4>> = [
    dispatch('administrador', 'adminA', 200),
    dispatch('sin token', undefined, 401),
    dispatch('cliente', 'clienteA', 403),
    dispatch('super sin distribuidora', 'super', 400, {
      code: 'MISSING_DISTRIBUTOR',
    }),
    putDispatch('guarda y relee', 'adminA', 200, {
      body: { radiusStepsKm: [2, 4], offerTtlSeconds: 20 },
      verificar: async (_b, c) =>
        expect(
          (await llamar(c, 'get', '/module-config/dispatch', 'adminA')).body,
        ).toMatchObject({ radiusStepsKm: [2, 4], offerTtlSeconds: 20 }),
    }),
    putDispatch('pasos no crecientes', 'adminA', 400, {
      body: { radiusStepsKm: [4, 2] },
    }),
    putDispatch('campo extra', 'adminA', 400, { body: { ajeno: true } }),
    putDispatch('sin token', undefined, 401),
    putDispatch('cliente', 'clienteA', 403),
    putDispatch('chofer', 'chofer', 403),
    express('administrador', 'adminA', 200),
    express('sin token', undefined, 401),
    express('chofer', 'chofer', 403),
    express('super sin distribuidora', 'super', 400, {
      code: 'MISSING_DISTRIBUTOR',
    }),
    (() => {
      let anterior: Record<string, unknown> = {};
      return putExpress('guarda, relee y restaura', 'adminA', 200, {
        body: { enabled: true, surchargeAmount: 1234 },
        antes: async (c) => {
          anterior = (
            await llamar(c, 'get', '/module-config/express_dispatch', 'adminA')
          ).body as Record<string, unknown>;
        },
        verificar: async (_b, c) => {
          expect(
            (
              await llamar(
                c,
                'get',
                '/module-config/express_dispatch',
                'adminA',
              )
            ).body,
          ).toMatchObject({ enabled: true, surchargeAmount: 1234 });
          await llamar(c, 'put', '/module-config/express_dispatch', 'adminA', {
            enabled: anterior.enabled,
            surchargeAmount: anterior.surchargeAmount,
            maxRadiusKm: anterior.maxRadiusKm,
            offerTtlSeconds: anterior.offerTtlSeconds,
            serviceFrom: anterior.serviceFrom,
            serviceTo: anterior.serviceTo,
            estimatedMinutes: anterior.estimatedMinutes,
            standardEstimatedMinutes: anterior.standardEstimatedMinutes,
          });
        },
      });
    })(),
    putExpress('horario inválido', 'adminA', 400, {
      body: { serviceFrom: '20:00', serviceTo: '08:00' },
    }),
    putExpress('tipo inválido', 'adminA', 400, { body: { enabled: 'si' } }),
    putExpress('sin token', undefined, 401),
    putExpress('cliente', 'clienteA', 403),
    putExpress('chofer', 'chofer', 403),
    putExpress('super sin distribuidora', 'super', 400, {
      body: {},
      code: 'MISSING_DISTRIBUTOR',
    }),
    processes('administrador', 'adminA', 200),
    processes('sin token', undefined, 401),
    processes('cliente', 'clienteA', 403),
    processes('super sin distribuidora', 'super', 400, {
      code: 'MISSING_DISTRIBUTOR',
    }),
    getProcess('proceso válido', 'adminA', 200),
    getProcess('proceso inexistente', 'adminA', 404, {
      ruta: '/module-config/no-existe',
    }),
    getProcess('sin token', undefined, 401),
    getProcess('cliente', 'clienteA', 403),
    getProcess('chofer', 'chofer', 403),
    getProcess('super sin distribuidora', 'super', 400, {
      code: 'MISSING_DISTRIBUTOR',
    }),
    putProcess('actualiza y relee', 'adminA', 200, {
      body: { enabled: 1 },
      verificar: async (_b, c) =>
        expect(
          (await llamar(c, 'get', '/module-config/repurchase', 'adminA')).body,
        ).toMatchObject({ params: { enabled: 1 } }),
    }),
    putProcess('campo inválido', 'adminA', 400, { body: { inexistente: 1 } }),
    putProcess('proceso inexistente', 'adminA', 404, {
      ruta: '/module-config/no-existe',
      body: {},
    }),
    putProcess('sin token', undefined, 401),
    putProcess('cliente', 'clienteA', 403),
    putProcess('chofer', 'chofer', 403),
    tasks('administrador', 'adminA', 200),
    tasks('super admin sin distribuidora', 'super', 400, {
      code: 'MISSING_DISTRIBUTOR',
    }),
    tasks('sin token', undefined, 401),
    tasks('cliente', 'clienteA', 403),
    putTasks('guarda y relee', 'adminA', 200, {
      body: { dispatchRetrySeconds: 30 },
      verificar: async (_b, c) =>
        expect(
          (await llamar(c, 'get', '/module-config/scheduled_tasks', 'adminA'))
            .body,
        ).toMatchObject({ dispatchRetrySeconds: 30 }),
    }),
    putTasks('intervalo inválido', 'adminA', 400, {
      body: { dispatchRetrySeconds: 17 },
    }),
    putTasks('sin token', undefined, 401),
    putTasks('cliente', 'clienteA', 403),
    putTasks('chofer', 'chofer', 403),
    surcharge('administrador', 'adminA', 200),
    surcharge('sin token', undefined, 401),
    surcharge('chofer', 'chofer', 403),
    surcharge('super sin distribuidora', 'super', 400, {
      code: 'MISSING_DISTRIBUTOR',
    }),
    putSurcharge('guarda y relee', 'adminA', 200, {
      body: {
        transferPercentage: 2,
        mercadoPagoPercentage: 3,
        cashPercentage: 0,
      },
      verificar: async (_b, c) =>
        expect(
          (await llamar(c, 'get', '/v2/payment-surcharges', 'adminA')).body,
        ).toMatchObject({ transferPercentage: 2, mercadoPagoPercentage: 3 }),
    }),
    putSurcharge('requerido', 'adminA', 400, {
      body: { transferPercentage: 1, cashPercentage: 0 },
    }),
    putSurcharge('rango', 'adminA', 400, {
      body: {
        transferPercentage: 31,
        mercadoPagoPercentage: 1,
        cashPercentage: 0,
      },
    }),
    putSurcharge('sin token', undefined, 401),
    putSurcharge('cliente', 'clienteA', 403),
    putSurcharge('chofer', 'chofer', 403),
  ];
  correrMatriz('configuración por tenant', ver, casos);
});
