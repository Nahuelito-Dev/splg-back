import { ScheduledTasksSettingsService } from './scheduled-tasks-settings.service';
import { ModuleConfigService } from './module-config.service';
import { RedisService } from '../redis/redis.service';
import { ConfigurableProcess } from './entities/module-config.entity';
import {
  scheduledTasksDesde,
  scheduledTasksPorDefecto,
} from './scheduled-tasks-settings';

/** Redis y base en memoria, compartidos por las "instancias" de cada test. */
function entorno() {
  const claves = new Map<string, string>();
  const ttls = new Map<string, number>();
  const redis = {
    get: jest.fn((k: string) => Promise.resolve(claves.get(k) ?? null)),
    incr: jest.fn((k: string) => {
      const n = Number(claves.get(k) ?? 0) + 1;
      claves.set(k, String(n));
      return Promise.resolve(n);
    }),
    del: jest.fn((k: string) => {
      claves.delete(k);
      return Promise.resolve();
    }),
    setIfAbsentMs: jest.fn((k: string, ms: number) => {
      if (claves.has(k)) return Promise.resolve(false);
      claves.set(k, '1');
      ttls.set(k, ms);
      return Promise.resolve(true);
    }),
  };
  let guardado: Record<string, unknown> | null = null;
  const configs = {
    parametros: jest.fn(() => Promise.resolve(guardado)),
    fila: jest.fn(() =>
      Promise.resolve(guardado ? { params: guardado, updatedAt: null } : null),
    ),
    guardar: jest.fn(
      (
        _d: string,
        _m: ConfigurableProcess,
        params: Record<string, unknown>,
      ) => {
        guardado = params;
        return Promise.resolve();
      },
    ),
  };
  const nuevaInstancia = () =>
    new ScheduledTasksSettingsService(
      configs as unknown as ModuleConfigService,
      redis as unknown as RedisService,
    );
  return { claves, ttls, redis, configs, nuevaInstancia };
}

describe('ScheduledTasksSettingsService (CU-173)', () => {
  let e: ReturnType<typeof entorno>;
  let service: ScheduledTasksSettingsService;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-15T12:00:00Z') });
    e = entorno();
    service = e.nuevaInstancia();
  });
  afterEach(() => jest.useRealTimers());

  it('los valores por omisión son los que regían: 60 s, 10 min, 2 h, 1 h y las 8', () => {
    expect(scheduledTasksPorDefecto()).toEqual({
      dispatchRetrySeconds: 60,
      reservationActivationSeconds: 600,
      unpaidReservationExpirySeconds: 7200,
      unpaidMercadoPagoExpirySeconds: 3600,
      fleetAlertHour: 8,
    });
  });

  describe('distribuidorasQueCorren', () => {
    it('con el intervalo configurado igual al tic corre siempre y no usa marcas', async () => {
      await service.guardar('d1', { dispatchRetrySeconds: 15 }, 'u1');
      const corren = await service.distribuidorasQueCorren(
        'dispatchRetrySeconds',
        ['d1', 'd2'],
      );
      expect([...corren]).toEqual(['d1', 'd2']);
      expect(e.redis.setIfAbsentMs).not.toHaveBeenCalled();
    });

    it('con intervalo mayor le toca si no hay marca; la deja con vencimiento medio tic antes del intervalo y bajo la generación', async () => {
      await service.guardar('d1', { dispatchRetrySeconds: 60 }, 'u1');

      const corren = await service.distribuidorasQueCorren(
        'dispatchRetrySeconds',
        ['d1'],
      );

      expect([...corren]).toEqual(['d1']);
      expect(e.redis.setIfAbsentMs).toHaveBeenCalledWith(
        'scheduled-task:dispatchRetrySeconds:d1:1',
        60_000 - 7_500,
      );
    });

    it('no le toca mientras la marca siga viva', async () => {
      await service.guardar('d1', { dispatchRetrySeconds: 60 }, 'u1');
      await service.distribuidorasQueCorren('dispatchRetrySeconds', ['d1']);

      const segundo = await service.distribuidorasQueCorren(
        'dispatchRetrySeconds',
        ['d1'],
      );
      expect(segundo.size).toBe(0);
    });

    it('cada distribuidora se decide una sola vez aunque venga repetida', async () => {
      await service.guardar('d1', { dispatchRetrySeconds: 60 }, 'u1');
      await service.distribuidorasQueCorren('dispatchRetrySeconds', [
        'd1',
        'd1',
      ]);
      expect(e.redis.setIfAbsentMs).toHaveBeenCalledTimes(1);
    });

    it('la marca es por tarea y por distribuidora', async () => {
      await service.guardar(
        'd1',
        {
          reservationActivationSeconds: 600,
          unpaidReservationExpirySeconds: 7200,
        },
        'u1',
      );
      await service.distribuidorasQueCorren('reservationActivationSeconds', [
        'd1',
      ]);
      await service.distribuidorasQueCorren('unpaidReservationExpirySeconds', [
        'd1',
      ]);
      expect(
        (e.redis.setIfAbsentMs.mock.calls as Array<[string, number]>).map(
          (c) => c[0],
        ),
      ).toEqual([
        'scheduled-task:reservationActivationSeconds:d1:1',
        'scheduled-task:unpaidReservationExpirySeconds:d1:1',
      ]);
    });
  });

  describe('liberarMarca', () => {
    it('borra la marca de esa distribuidora: no pierde un intervalo entero', async () => {
      await service.guardar('d1', { dispatchRetrySeconds: 60 }, 'u1');
      await service.distribuidorasQueCorren('dispatchRetrySeconds', ['d1']);

      await service.liberarMarca('dispatchRetrySeconds', 'd1');

      const otra = await service.distribuidorasQueCorren(
        'dispatchRetrySeconds',
        ['d1'],
      );
      expect([...otra]).toEqual(['d1']);
    });
  });

  describe('generación (varias instancias)', () => {
    it('guardar sube la generación y descarta la marca de la generación anterior', async () => {
      await service.guardar('d1', { dispatchRetrySeconds: 60 }, 'u1');
      await service.distribuidorasQueCorren('dispatchRetrySeconds', ['d1']);
      expect(e.claves.has('scheduled-task:dispatchRetrySeconds:d1:1')).toBe(
        true,
      );

      await service.guardar('d1', { dispatchRetrySeconds: 120 }, 'u1');

      expect(e.claves.get('scheduled-task:gen:d1')).toBe('2');
      expect(e.claves.has('scheduled-task:dispatchRetrySeconds:d1:1')).toBe(
        false,
      );
    });

    it('un PUT en una instancia: el tic de OTRA con la caché vieja respeta el intervalo nuevo', async () => {
      const a = e.nuevaInstancia();
      const b = e.nuevaInstancia();
      // B carga la configuración vieja (por omisión) en su caché.
      expect((await b.obtener('d1')).dispatchRetrySeconds).toBe(60);

      await a.guardar('d1', { dispatchRetrySeconds: 120 }, 'u1');

      // Sin esperar el minuto de la caché de B: ve la generación nueva y relee.
      expect((await b.obtener('d1')).dispatchRetrySeconds).toBe(120);
      const primero = await b.distribuidorasQueCorren('dispatchRetrySeconds', [
        'd1',
      ]);
      const segundo = await b.distribuidorasQueCorren('dispatchRetrySeconds', [
        'd1',
      ]);
      expect([...primero]).toEqual(['d1']);
      expect(segundo.size).toBe(0);
    });

    it('una marca creada con la configuración vieja después del PUT no frena el intervalo nuevo', async () => {
      const a = e.nuevaInstancia();
      const b = e.nuevaInstancia();
      await a.guardar('d1', { dispatchRetrySeconds: 60 }, 'u1');
      await b.obtener('d1');

      await a.guardar('d1', { dispatchRetrySeconds: 30 }, 'u1');
      // Un tic en curso de B escribe una marca bajo la generación vieja (1).
      e.claves.set('scheduled-task:dispatchRetrySeconds:d1:1', '1');

      const corren = await b.distribuidorasQueCorren('dispatchRetrySeconds', [
        'd1',
      ]);
      expect([...corren]).toEqual(['d1']);
    });
  });

  describe('guardar', () => {
    it('guarda sólo lo que vino, con quién modificó', async () => {
      await service.guardar(
        'd1',
        {
          dispatchRetrySeconds: 45,
          fleetAlertHour: undefined,
          reservationActivationSeconds: null as unknown as undefined,
        },
        'u1',
      );
      const guardado = (
        e.configs.guardar.mock.calls as unknown as Array<
          [string, ConfigurableProcess, Record<string, unknown>, string]
        >
      )[0];
      expect(guardado[2]).toStrictEqual({ dispatchRetrySeconds: 45 });
    });

    it('lo que falta se lee con su valor por omisión', async () => {
      const r = await service.guardar('d1', { fleetAlertHour: 20 }, 'u1');
      expect(r).toMatchObject({
        dispatchRetrySeconds: 60,
        fleetAlertHour: 20,
        isDefault: false,
      });
    });

    it('un PUT sin campos restablece: isDefault true', async () => {
      await service.guardar('d1', { fleetAlertHour: 20 }, 'u1');
      const r = await service.guardar('d1', {}, 'u1');
      expect(r.isDefault).toBe(true);
      expect(r.fleetAlertHour).toBe(8);
    });

    it('si todo lo guardado coincide con los valores por omisión, isDefault es true', async () => {
      const r = await service.guardar(
        'd1',
        { dispatchRetrySeconds: 60, fleetAlertHour: 8 },
        'u1',
      );
      expect(r.isDefault).toBe(true);
    });
  });

  describe('v1 congelada y configuración de plataforma (E3)', () => {
    it('v1 conserva el contrato: la empresa puede cambiar las frecuencias y la hora', async () => {
      await service.guardarDeLaPlataforma(
        'd1',
        { dispatchRetrySeconds: 60, unpaidMercadoPagoExpirySeconds: 3600 },
        'super',
      );
      const r = await service.guardar(
        'd1',
        { dispatchRetrySeconds: 30, fleetAlertHour: 20 },
        'admin',
      );
      expect(e.configs.guardar).toHaveBeenLastCalledWith(
        'd1',
        ConfigurableProcess.SCHEDULED_TASKS,
        {
          dispatchRetrySeconds: 30,
          fleetAlertHour: 20,
        },
        'admin',
      );
      expect(r).toMatchObject({
        dispatchRetrySeconds: 30,
        fleetAlertHour: 20,
      });
    });

    it('la plataforma actualiza las frecuencias por merge y conserva la hora de la empresa', async () => {
      await service.guardarDeLaPlataforma(
        'd1',
        { reservationActivationSeconds: 900 },
        'super',
      );
      await service.guardarHoraDeLaEmpresa(
        'd1',
        { fleetAlertHour: 6 },
        'admin',
      );
      const r = await service.guardarDeLaPlataforma(
        'd1',
        { dispatchRetrySeconds: 45 },
        'super',
      );
      expect(e.configs.guardar).toHaveBeenLastCalledWith(
        'd1',
        ConfigurableProcess.SCHEDULED_TASKS,
        {
          fleetAlertHour: 6,
          dispatchRetrySeconds: 45,
          reservationActivationSeconds: 900,
        },
        'super',
      );
      expect(r.reservationActivationSeconds).toBe(900);
      expect(r.fleetAlertHour).toBe(6);
    });

    it('la empresa conserva las frecuencias de plataforma cuando sólo cambia su hora', async () => {
      await service.guardarDeLaPlataforma(
        'd1',
        { reservationActivationSeconds: 900 },
        'super',
      );

      const r = await service.guardarHoraDeLaEmpresa(
        'd1',
        { fleetAlertHour: 6 },
        'admin',
      );

      expect(r).toMatchObject({
        reservationActivationSeconds: 900,
        fleetAlertHour: 6,
      });
    });

    it('la plataforma no toca la hora del aviso aunque se la pasen', async () => {
      await service.guardar('d1', { fleetAlertHour: 6 }, 'admin');
      await service.guardarDeLaPlataforma(
        'd1',
        { fleetAlertHour: 22 } as never,
        'super',
      );
      expect(e.configs.guardar).toHaveBeenLastCalledWith(
        'd1',
        ConfigurableProcess.SCHEDULED_TASKS,
        { fleetAlertHour: 6 },
        'super',
      );
    });
  });

  it('copia en memoria de un minuto por distribuidora', async () => {
    await service.obtener('d1');
    jest.advanceTimersByTime(59_000);
    await service.obtener('d1');
    expect(e.configs.parametros).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2_000);
    await service.obtener('d1');
    expect(e.configs.parametros).toHaveBeenCalledTimes(2);
  });

  it('esLaHoraDelAvisoDeFlota compara con la hora configurada (8 por omisión)', async () => {
    expect(await service.esLaHoraDelAvisoDeFlota('d1', 8)).toBe(true);
    expect(await service.esLaHoraDelAvisoDeFlota('d1', 9)).toBe(false);
    await service.guardar('d2', { fleetAlertHour: 20 }, 'u1');
    expect(await service.esLaHoraDelAvisoDeFlota('d2', 20)).toBe(true);
  });

  it('un JSON guardado inválido cae al valor por omisión (reintento > 5 min incluido)', () => {
    expect(
      scheduledTasksDesde({
        dispatchRetrySeconds: 600,
        fleetAlertHour: 30,
        reservationActivationSeconds: 600,
      }),
    ).toEqual({
      ...scheduledTasksPorDefecto(),
      reservationActivationSeconds: 600,
    });
  });
});
