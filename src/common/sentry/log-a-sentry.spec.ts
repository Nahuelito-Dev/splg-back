import * as Sentry from '@sentry/nestjs';
import { ContextoDeTraza } from '../traza/contexto-de-traza';
import { LoggerConTraza } from '../traza/logger-con-traza';
import { logASentry } from './log-a-sentry';
import {
  iniciarSentryDePrueba,
  type SalidaDeSentry,
} from './testing/sentry-de-prueba';

describe('logs hacia Sentry', () => {
  let salida: SalidaDeSentry;

  beforeAll(() => {
    salida = iniciarSentryDePrueba();
  });

  afterAll(async () => {
    await Sentry.close();
  });

  beforeEach(() => {
    salida.logs.length = 0;
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  describe('logASentry', () => {
    it('manda el mensaje con su contexto y la traza de la app', async () => {
      logASentry('error', 'cupo agotado', ['Dispatch'], 'traza-1');
      await Sentry.flush(1000);
      expect(salida.logs).toHaveLength(1);
      expect(salida.logs[0]).toMatchObject({
        level: 'error',
        message: 'cupo agotado',
        attributes: expect.objectContaining({
          context: 'Dispatch',
          app_trace_id: 'traza-1',
          'sentry.release': 'splg-server@1.0.0',
          'sentry.environment': 'test',
        }) as unknown,
      });
    });

    it('el stack de logger.error(mensaje, stack, contexto) no se toma por contexto', async () => {
      const stack = 'Error: x\n    at f (a.ts:1:1)';
      logASentry('error', 'falló', [stack], undefined);
      logASentry('error', new Error('objeto error'), [stack, 'Pagos'], null);
      logASentry('error', { motivo: 'json' }, [], undefined);
      await Sentry.flush(1000);
      expect(
        salida.logs.map((l) => [l.message, l.attributes?.context]),
      ).toEqual([
        ['falló', undefined],
        ['objeto error', 'Pagos'],
        ['{"motivo":"json"}', undefined],
      ]);
    });

    it('un mensaje que no se puede pasar a JSON sale como texto', async () => {
      const ciclico: Record<string, unknown> = {};
      ciclico.yo = ciclico;
      logASentry('error', ciclico, [], undefined);
      logASentry('error', undefined, [], undefined);
      await Sentry.flush(1000);
      expect(salida.logs.map((l) => l.message)).toEqual([
        '[object Object]',
        'undefined',
      ]);
    });
  });

  describe('LoggerConTraza', () => {
    it('sólo error va a Sentry; warn, log, debug y verbose no', async () => {
      const logger = new LoggerConTraza('Prueba', { colors: false });
      ContextoDeTraza.abrir({ traceId: 'traza-xyz', origen: 'http' }, () => {
        logger.log('info suelta');
        logger.debug('detalle');
        logger.verbose('más detalle');
        logger.warn('ojo con ana@example.com', 'Prueba');
        logger.error('se rompió', 'Error: x\n    at f (a.ts:1:1)', 'Prueba');
      });
      await Sentry.flush(1000);
      expect(
        salida.logs.map((l) => [
          l.level,
          l.message,
          l.attributes?.app_trace_id,
        ]),
      ).toEqual([['error', 'se rompió', 'traza-xyz']]);
    });

    it('con el nivel apagado no manda nada', async () => {
      const logger = new LoggerConTraza('Prueba', { logLevels: ['fatal'] });
      logger.error('no sale');
      await Sentry.flush(1000);
      expect(salida.logs).toHaveLength(0);
    });
  });
});
