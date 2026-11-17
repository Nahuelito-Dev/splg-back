import { BadRequestException, ConflictException } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import {
  BadRequestDomainError,
  ConflictDomainError,
} from '../common/errors/domain.error';
import { Repository } from 'typeorm';
import { ProcessName } from './domain/process-catalog';
import { ProcessRun } from './entities/process-run.entity';
import { ProcessRunRecorder } from './process-run.recorder';
import {
  iniciarSentryDePrueba,
  type SalidaDeSentry,
} from '../common/sentry/testing/sentry-de-prueba';
import {
  dentroDeCorrida,
  nuevaCorrida,
  registrarErrorAtrapado,
  registrarFallaDeElemento,
} from './process-run.context';

class PedidoYaAsignado extends ConflictDomainError {
  constructor() {
    super('El pedido ya tiene chofer');
  }
}
class FranjaInvalida extends BadRequestDomainError {
  constructor() {
    super('Franja inválida');
  }
}

/** Los errores que un proceso atrapa para seguir también llegan a Sentry. */
describe('registrarErrorAtrapado → Sentry', () => {
  let salida: SalidaDeSentry;

  beforeAll(() => {
    salida = iniciarSentryDePrueba();
  });

  afterAll(async () => {
    await Sentry.close();
  });

  beforeEach(() => {
    salida.errores.length = 0;
  });

  it('dentro de una corrida va con el proceso y la empresa como tags, y sigue contando', async () => {
    const estado = nuevaCorrida(ProcessName.DISPATCH_TICK, 'dist-1');
    dentroDeCorrida(estado, () =>
      registrarErrorAtrapado(new Error('Mercado Pago no respondió')),
    );
    await Sentry.flush(1000);

    expect(estado.errors).toBe(1);
    expect(estado.lastError).toBe('Mercado Pago no respondió');
    expect(salida.errores).toHaveLength(1);
    expect(salida.errores[0].tags).toMatchObject({
      process: ProcessName.DISPATCH_TICK,
      distributor: 'dist-1',
      process_fatal: 'false',
    });
    expect(salida.errores[0].level).toBe('warning');
    expect(salida.errores[0].exception?.values?.[0].value).toBe(
      'Mercado Pago no respondió',
    );
  });

  it('el fatal va como error', async () => {
    const estado = nuevaCorrida(ProcessName.ROUTE_BATCH_BUILD);
    dentroDeCorrida(estado, () =>
      registrarErrorAtrapado(new Error('se cortó la corrida'), true),
    );
    await Sentry.flush(1000);
    expect(estado.fatal).toBe('se cortó la corrida');
    expect(salida.errores[0].tags).toMatchObject({
      process: ProcessName.ROUTE_BATCH_BUILD,
      process_fatal: 'true',
    });
    expect(salida.errores[0].tags).not.toHaveProperty('distributor');
    expect(salida.errores[0].level).toBe('error');
  });

  it('la falla de un elemento también se manda', async () => {
    const estado = nuevaCorrida(ProcessName.ROUTE_BATCH_EXPIRY);
    dentroDeCorrida(estado, () =>
      registrarFallaDeElemento('aviso:1', new Error('aviso roto')),
    );
    await Sentry.flush(1000);
    expect(salida.errores).toHaveLength(1);
    expect(salida.errores[0].tags).toMatchObject({
      process: ProcessName.ROUTE_BATCH_EXPIRY,
    });
  });

  it('fuera de una corrida registrada se manda igual, sin proceso', async () => {
    registrarErrorAtrapado(new Error('suelto'));
    await Sentry.flush(1000);
    expect(salida.errores).toHaveLength(1);
    expect(salida.errores[0].tags).not.toHaveProperty('process');
  });

  it('un 4xx atrapado es una respuesta esperada: cuenta en la corrida pero no va a Sentry', async () => {
    const estado = nuevaCorrida(ProcessName.DISPATCH_TICK);
    dentroDeCorrida(estado, () => {
      registrarErrorAtrapado(new ConflictException('ya asignado'));
      registrarErrorAtrapado(new BadRequestException('dato inválido'));
    });
    await Sentry.flush(1000);
    expect(estado.errors).toBe(2);
    expect(salida.errores).toHaveLength(0);
  });

  it('el registrador le pasa a la corrida el proceso y la empresa', async () => {
    const qb = {
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest
        .fn()
        .mockResolvedValue({ identifiers: [{ runId: 'run-1' }] }),
    };
    const recorder = new ProcessRunRecorder({
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    } as unknown as Repository<ProcessRun>);

    await recorder.ejecutar(ProcessName.FLEET_PLANNER_DAILY, 'dist-9', () => {
      registrarErrorAtrapado(new Error('vehículo sin datos'));
      return Promise.resolve(1);
    });
    await Sentry.flush(1000);

    expect(salida.errores).toHaveLength(1);
    expect(salida.errores[0].tags).toMatchObject({
      process: ProcessName.FLEET_PLANNER_DAILY,
      distributor: 'dist-9',
    });
  });

  it('un error de dominio que en HTTP sería 4xx tampoco va', async () => {
    const estado = nuevaCorrida(ProcessName.DISPATCH_TICK);
    dentroDeCorrida(estado, () => {
      registrarErrorAtrapado(new PedidoYaAsignado());
      registrarFallaDeElemento('pedido:1', new FranjaInvalida());
    });
    await Sentry.flush(1000);
    expect(estado.errors).toBe(2);
    expect(salida.errores).toHaveLength(0);
  });

  it('el mismo error del mismo proceso sale una sola vez por ventana, aunque siga contando', async () => {
    const estado = nuevaCorrida(ProcessName.VEHICLE_USAGE_FEED);
    dentroDeCorrida(estado, () => {
      registrarErrorAtrapado(new Error('Redis caído en el intento 1'));
      registrarErrorAtrapado(new Error('Redis caído en el intento 2'));
      registrarFallaDeElemento(
        'auto:7',
        new Error('Redis caído en el intento 3'),
      );
    });
    await Sentry.flush(1000);
    expect(estado.errors).toBe(3);
    expect(salida.errores).toHaveLength(1);
  });
});
