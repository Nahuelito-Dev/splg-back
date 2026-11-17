import { RedisService } from '../../redis/redis.service';
import { CylinderRecoveryCron } from './cylinder-recovery.cron';
import { CylinderRecoveryService } from './cylinder-recovery.service';
import { PARAMETROS } from './recovery-test-kit';
import { empresasDePrueba } from '../../process-run/testing/empresas-de-prueba';

const memoriaRedis = () => {
  const m = new Map<string, string>();
  return {
    get: jest.fn((k: string) => Promise.resolve(m.get(k) ?? null)),
    setex: jest.fn((k: string, _t: number, v: string) => {
      m.set(k, v);
      return Promise.resolve();
    }),
  };
};

describe('CylinderRecoveryCron', () => {
  let recovery: {
    distribuidorasConEnvasesAfuera: jest.Mock;
    parametros: jest.Mock;
    ejecutar: jest.Mock;
  };
  let redis: { withLock: jest.Mock };
  let cron: CylinderRecoveryCron;
  let sinRecupero: Set<string>;
  // 07:00 UTC = 04:00 en Argentina
  const A_LAS_4 = new Date('2026-10-31T07:00:00Z');

  beforeEach(() => {
    recovery = {
      distribuidorasConEnvasesAfuera: jest.fn().mockResolvedValue(['d1', 'd2']),
      parametros: jest.fn().mockResolvedValue(PARAMETROS),
      ejecutar: jest.fn().mockResolvedValue({
        abiertos: 0,
        avisos: 0,
        ofertas: 0,
        escalados: 0,
        perdidos: 0,
        cerradosPorDevolucion: 0,
        cerradosPorCuenta: 0,
        revisionManual: 0,
      }),
    };
    redis = {
      withLock: jest.fn((_k: string, _t: number, fn: () => Promise<void>) =>
        fn().then(() => ({ obtenido: true, valor: undefined })),
      ),
    };
    sinRecupero = new Set();
    cron = new CylinderRecoveryCron(
      recovery as unknown as CylinderRecoveryService,
      { ...redis, ...memoriaRedis() } as unknown as RedisService,
      empresasDePrueba({
        distribuidoras: { findAll: () => Promise.resolve([]) },
        habilitado: (id, modulo) =>
          !(modulo === 'cylinder_recovery' && sinRecupero.has(id)),
      }).empresas,
    );
  });

  it('corre sólo las distribuidoras cuya hora de ejecución es la actual', async () => {
    recovery.parametros
      .mockResolvedValueOnce({ ...PARAMETROS, runHour: 4 })
      .mockResolvedValueOnce({ ...PARAMETROS, runHour: 9 });
    expect(await cron.recuperarLasQueTocan(A_LAS_4)).toBe(1);
    expect(recovery.ejecutar).toHaveBeenCalledTimes(1);
    expect(recovery.ejecutar).toHaveBeenCalledWith('d1', A_LAS_4);
  });

  it('una distribuidora con el recupero apagado no corre (apagado por omisión)', async () => {
    recovery.parametros.mockResolvedValue({
      ...PARAMETROS,
      runHour: 4,
      enabled: false,
    });
    expect(await cron.recuperarLasQueTocan(A_LAS_4)).toBe(0);
    expect(recovery.ejecutar).not.toHaveBeenCalled();
  });

  it('sin el recupero habilitado por la plataforma no corre en esa empresa; en otra sí', async () => {
    recovery.parametros.mockResolvedValue({ ...PARAMETROS, runHour: 4 });
    sinRecupero.add('d1');
    expect(await cron.recuperarLasQueTocan(A_LAS_4)).toBe(1);
    expect(recovery.ejecutar).toHaveBeenCalledTimes(1);
    expect(recovery.ejecutar).toHaveBeenCalledWith('d2', A_LAS_4);
  });

  it('una distribuidora que falla no frena a la siguiente', async () => {
    recovery.parametros.mockResolvedValue({ ...PARAMETROS, runHour: 4 });
    recovery.ejecutar.mockRejectedValueOnce(new Error('boom'));
    expect(await cron.recuperarLasQueTocan(A_LAS_4)).toBe(1);
  });

  it('corre bajo cerrojo distribuido', async () => {
    await cron.recuperar();
    expect(redis.withLock).toHaveBeenCalledWith(
      CylinderRecoveryCron.CERROJO,
      CylinderRecoveryCron.CERROJO_TTL_MS,
      expect.any(Function),
    );
    expect(recovery.distribuidorasConEnvasesAfuera).toHaveBeenCalled();
  });

  it('si otra instancia tiene el cerrojo no corre', async () => {
    redis.withLock.mockResolvedValue({ obtenido: false });
    await cron.recuperar();
    expect(recovery.ejecutar).not.toHaveBeenCalled();
  });

  it('un fallo del cerrojo no se propaga', async () => {
    redis.withLock.mockRejectedValue(new Error('redis caído'));
    await expect(cron.recuperar()).resolves.toBeUndefined();
  });

  it('si el recupero se apaga después de elegir la empresa, no abre casos (re-consulta sin caché)', async () => {
    recovery.parametros.mockImplementation((id: string) => {
      if (id === 'd1') sinRecupero.add(id);
      return Promise.resolve({ ...PARAMETROS, runHour: 4 });
    });
    expect(await cron.recuperarLasQueTocan(A_LAS_4)).toBe(1);
    expect(recovery.ejecutar).toHaveBeenCalledTimes(1);
    expect(recovery.ejecutar).toHaveBeenCalledWith('d2', A_LAS_4);
  });

  describe('corrida diaria recuperable', () => {
    const exacta = A_LAS_4;
    const unaHoraDespues = new Date(exacta.getTime() + 3_600_000);
    const unaHoraAntes = new Date(exacta.getTime() - 3_600_000);
    const diaSiguiente = new Date(exacta.getTime() + 24 * 3_600_000);

    it('a la hora exacta corre', async () => {
      recovery.parametros.mockResolvedValue({ ...PARAMETROS, runHour: 4 });
      expect(await cron.recuperarLasQueTocan(exacta)).toBe(2);
    });

    it('una hora después sin corrida previa hoy recupera', async () => {
      recovery.parametros.mockResolvedValue({ ...PARAMETROS, runHour: 4 });
      expect(await cron.recuperarLasQueTocan(unaHoraDespues)).toBe(2);
    });

    it('una hora después con corrida hoy no corre', async () => {
      recovery.parametros.mockResolvedValue({ ...PARAMETROS, runHour: 4 });
      await cron.recuperarLasQueTocan(exacta);
      recovery.ejecutar.mockClear();
      expect(await cron.recuperarLasQueTocan(unaHoraDespues)).toBe(0);
      expect(recovery.ejecutar).not.toHaveBeenCalled();
    });

    it('antes de la hora no corre', async () => {
      recovery.parametros.mockResolvedValue({ ...PARAMETROS, runHour: 4 });
      expect(await cron.recuperarLasQueTocan(unaHoraAntes)).toBe(0);
    });

    it('al día siguiente vuelve a correr', async () => {
      recovery.parametros.mockResolvedValue({ ...PARAMETROS, runHour: 4 });
      await cron.recuperarLasQueTocan(exacta);
      expect(await cron.recuperarLasQueTocan(diaSiguiente)).toBe(2);
    });
  });
});
