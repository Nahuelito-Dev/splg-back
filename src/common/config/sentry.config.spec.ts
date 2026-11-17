import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Sentry from '@sentry/nestjs';
import type { NodeOptions } from '@sentry/nestjs';
import {
  antesDeEnviarError,
  antesDeEnviarLog,
  antesDeEnviarSpan,
} from '../sentry/filtros-de-sentry';
import {
  iniciarSentry,
  monitorearCrons,
  muestreoDeTrazas,
  opcionesDeSentry,
  versionDelPaquete,
} from './sentry.config';

const DSN = 'https://clave@o1.ingest.sentry.io/2';

describe('configuración de Sentry', () => {
  describe('iniciarSentry', () => {
    it('sin SENTRY_DSN no inicializa nada', () => {
      const init = jest.fn();
      expect(iniciarSentry({ NODE_ENV: 'development' }, init)).toBe(false);
      expect(iniciarSentry({ SENTRY_DSN: '  ' }, init)).toBe(false);
      expect(init).not.toHaveBeenCalled();
    });

    it('sin SENTRY_DSN el SDK real queda sin cliente', () => {
      expect(iniciarSentry({})).toBe(false);
      expect(Sentry.getClient()).toBeUndefined();
      expect(Sentry.isInitialized()).toBe(false);
    });

    it('con SENTRY_DSN inicializa con las opciones armadas', () => {
      const init = jest.fn();
      expect(iniciarSentry({ SENTRY_DSN: DSN, NODE_ENV: 'test' }, init)).toBe(
        true,
      );
      expect(init).toHaveBeenCalledWith(
        expect.objectContaining({ dsn: DSN, environment: 'test' }),
      );
    });
  });

  describe('opcionesDeSentry', () => {
    it('sin DSN no hay opciones', () => {
      expect(opcionesDeSentry({ NODE_ENV: 'production' })).toBeNull();
    });

    it('entorno: SENTRY_ENVIRONMENT, si no NODE_ENV, si no development', () => {
      expect(
        opcionesDeSentry(
          {
            SENTRY_DSN: DSN,
            SENTRY_ENVIRONMENT: 'staging',
            NODE_ENV: 'production',
          },
          '1.0.0',
        )?.environment,
      ).toBe('staging');
      expect(
        opcionesDeSentry({ SENTRY_DSN: DSN, NODE_ENV: 'production' }, '1.0.0')
          ?.environment,
      ).toBe('production');
      expect(opcionesDeSentry({ SENTRY_DSN: DSN }, '1.0.0')?.environment).toBe(
        'development',
      );
    });

    it('release: SENTRY_RELEASE o splg-server@<versión del paquete>', () => {
      expect(
        opcionesDeSentry(
          { SENTRY_DSN: DSN, SENTRY_RELEASE: 'splg-server@2.1.0' },
          '1.0.0',
        )?.release,
      ).toBe('splg-server@2.1.0');
      expect(opcionesDeSentry({ SENTRY_DSN: DSN }, '1.4.2')?.release).toBe(
        'splg-server@1.4.2',
      );
    });

    it('trazas: todas en development, 10 % en el resto, o la de la variable', () => {
      const tasa = (env: Record<string, string>): number | undefined =>
        opcionesDeSentry({ SENTRY_DSN: DSN, ...env }, '1.0.0')
          ?.tracesSampleRate;
      expect(tasa({ NODE_ENV: 'development' })).toBe(1);
      expect(tasa({ NODE_ENV: 'production' })).toBe(0.1);
      expect(
        tasa({ NODE_ENV: 'production', SENTRY_TRACES_SAMPLE_RATE: '0.5' }),
      ).toBe(0.5);
    });

    it('no manda datos personales por su cuenta y filtra antes de enviar', () => {
      const opciones = opcionesDeSentry(
        { SENTRY_DSN: DSN },
        '1.0.0',
      ) as NodeOptions;
      expect(opciones.dataCollection).toMatchObject({
        userInfo: false,
        cookies: false,
        httpBodies: [],
        urlQueryParams: false,
        databaseQueryData: false,
        stackFrameVariables: false,
      });
      expect(opciones.beforeSend).toBe(antesDeEnviarError);
      expect(opciones.beforeSendLog).toBe(antesDeEnviarLog);
      expect(opciones.beforeSendSpan).toBe(antesDeEnviarSpan);
    });

    it('incluye la integración de Nest', () => {
      const opciones = opcionesDeSentry({ SENTRY_DSN: DSN }, '1.0.0');
      const integraciones = Array.isArray(opciones?.integrations)
        ? opciones.integrations.map((i) => i.name)
        : [];
      expect(integraciones).toEqual(['Nest']);
    });
  });

  describe('monitorearCrons', () => {
    it.each([
      [undefined, false],
      ['', false],
      ['false', false],
      ['true', true],
      [' TRUE ', true],
    ])('SENTRY_MONITOR_CRONS=«%s» da %s', (texto, esperado) => {
      expect(monitorearCrons({ SENTRY_MONITOR_CRONS: texto })).toBe(esperado);
    });
  });

  describe('muestreoDeTrazas', () => {
    it.each([
      ['0', 'production', 0],
      ['1', 'production', 1],
      ['1.5', 'production', 0.1],
      ['-0.1', 'development', 1],
      ['abc', 'production', 0.1],
      [undefined, 'staging', 0.1],
    ])('«%s» en %s da %s', (texto, entorno, esperado) => {
      expect(muestreoDeTrazas(texto, entorno)).toBe(esperado);
    });
  });

  describe('versionDelPaquete', () => {
    it('lee la versión de package.json', () => {
      const dir = mkdtempSync(join(tmpdir(), 'splg-sentry-'));
      const ruta = join(dir, 'package.json');
      writeFileSync(ruta, JSON.stringify({ version: '3.2.1' }));
      expect(versionDelPaquete(ruta)).toBe('3.2.1');
      writeFileSync(ruta, JSON.stringify({ name: 'x' }));
      expect(versionDelPaquete(ruta)).toBe('sin-version');
      expect(versionDelPaquete(join(dir, 'no-existe.json'))).toBe(
        'sin-version',
      );
    });

    it('por defecto, la del package.json del repo', () => {
      expect(versionDelPaquete()).toMatch(/^\d+\.\d+\.\d+/);
    });
  });
});
