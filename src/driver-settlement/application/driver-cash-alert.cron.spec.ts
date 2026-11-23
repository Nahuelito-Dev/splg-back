import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource } from 'typeorm';
import { EVENTO_NOTIFICAR_ADMIN } from '../../common/events/notificar-admin.event';
import type { ProcessConfigService } from '../../distributor/process-config.service';
import type { EmpresasParaProceso } from '../../process-run/empresas-para-proceso';
import type { RedisService } from '../../redis/redis.service';
import {
  AVISO_EFECTIVO_SIN_RENDIR,
  DriverCashAlertCron,
  horaArgentina,
  antiguedadEnTexto,
  textoDelAviso,
} from './driver-cash-alert.cron';
import { efectivoSinRendirPorChofer } from './settlement-orders';

jest.mock('./settlement-orders', () => ({
  efectivoSinRendirPorChofer: jest.fn(),
}));

const choferes = [
  {
    deliveryId: 'ch1',
    driverName: 'Juan Pérez',
    orders: 3,
    amount: 54000,
    oldestDeliveredAt: new Date('2026-11-20T15:00:00Z'),
    ageHours: 51,
  },
  {
    deliveryId: 'ch2',
    driverName: null,
    orders: 1,
    amount: 8000.5,
    oldestDeliveredAt: new Date('2026-11-21T15:00:00Z'),
    ageHours: 27,
  },
];

describe('DriverCashAlertCron', () => {
  // 23:00 UTC = 20:00 en Argentina.
  const cierre = new Date('2026-11-22T23:00:00Z');
  let params: Record<string, number>;
  let emit: jest.Mock;
  const emitidos = () =>
    emit.mock.calls as Array<[string, Record<string, unknown>]>;
  let cron: DriverCashAlertCron;

  beforeEach(() => {
    params = { enabled: 1, closeHour: 20, minHours: 24 };
    emit = jest.fn();
    (efectivoSinRendirPorChofer as jest.Mock).mockReset();
    (efectivoSinRendirPorChofer as jest.Mock).mockResolvedValue(choferes);
    const empresas = {
      recorrer: jest.fn(
        async (_o: unknown, fn: (id: string) => Promise<boolean>) => ({
          empresas: [
            { distributorId: 'd1', estado: 'ok', valor: await fn('d1') },
          ],
          salteadas: 0,
        }),
      ),
    };
    cron = new DriverCashAlertCron(
      { manager: {} } as unknown as DataSource,
      {
        obtener: jest.fn(() => Promise.resolve(params)),
      } as unknown as ProcessConfigService,
      {} as unknown as RedisService,
      empresas as unknown as EmpresasParaProceso,
      { emit } as unknown as EventEmitter2,
    );
  });

  it('a la hora de cierre pide un aviso con el efectivo de más de N horas', async () => {
    await cron.ejecutarSinCerrojo(cierre);

    expect(efectivoSinRendirPorChofer).toHaveBeenCalledWith(
      expect.anything(),
      'd1',
      { ahora: cierre, masViejosDeHoras: 24 },
    );
    expect(emit).toHaveBeenCalledTimes(1);
    const [evento, aviso] = emitidos()[0];
    expect(evento).toBe(EVENTO_NOTIFICAR_ADMIN);
    expect(aviso).toMatchObject({
      distributorId: 'd1',
      kind: AVISO_EFECTIVO_SIN_RENDIR,
      dedupeKey: `${AVISO_EFECTIVO_SIN_RENDIR}:2026-11-22`,
      title: 'Efectivo sin rendir: $62.000,50',
    });
  });

  it('fuera de la hora de cierre no consulta ni avisa', async () => {
    await cron.ejecutarSinCerrojo(new Date('2026-11-22T22:00:00Z'));

    expect(efectivoSinRendirPorChofer).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('apagado por la empresa no avisa', async () => {
    params.enabled = 0;
    await cron.ejecutarSinCerrojo(cierre);
    expect(emit).not.toHaveBeenCalled();
  });

  it('sin efectivo viejo sin rendir no avisa', async () => {
    (efectivoSinRendirPorChofer as jest.Mock).mockResolvedValue([]);
    await cron.ejecutarSinCerrojo(cierre);
    expect(emit).not.toHaveBeenCalled();
  });

  it('la clave de deduplicación cambia con el día (un aviso por día)', async () => {
    await cron.ejecutarSinCerrojo(cierre);
    await cron.ejecutarSinCerrojo(new Date('2026-11-23T23:00:00Z'));
    expect(emitidos()[0][1].dedupeKey).not.toBe(emitidos()[1][1].dedupeKey);
  });

  it('la hora de Argentina sale del instante, no de la del servidor', () => {
    expect(horaArgentina(new Date('2026-11-22T02:59:00Z'))).toBe(23);
    expect(horaArgentina(new Date('2026-11-22T03:00:00Z'))).toBe(0);
  });

  it('el texto cuenta choferes, pedidos y horas, y resume los de más', () => {
    const { body } = textoDelAviso(choferes, 24);
    expect(body).toContain(
      '2 choferes cobraron en efectivo 4 pedidos entregados hace más de 24 h y todavía no lo rindieron',
    );
    expect(body).toContain(
      'Juan Pérez: $54.000 (3 pedidos entregados, hace 2 d 3 h)',
    );
    expect(body).toContain(
      'Chofer sin nombre: $8.000,50 (1 pedido entregado, hace 1 d 3 h)',
    );
    const muchos = Array.from({ length: 7 }, (_, i) => ({
      ...choferes[0],
      deliveryId: `c${i}`,
    }));
    expect(textoDelAviso(muchos, 24).body).toContain('y 2 más');
  });

  it('concuerda en singular: «1 chofer cobró … 1 pedido entregado … no lo rindió»', () => {
    const { body } = textoDelAviso([{ ...choferes[1], orders: 1 }], 24);
    expect(body).toContain(
      '1 chofer cobró en efectivo 1 pedido entregado hace más de 24 h y todavía no lo rindió.',
    );
  });

  it('la antigüedad va en días y horas como el panel', () => {
    expect(antiguedadEnTexto(5)).toBe('5 h');
    expect(antiguedadEnTexto(98 * 24 + 2)).toBe('98 d 2 h');
    expect(antiguedadEnTexto(48)).toBe('2 d');
  });
});
