import { RedisService } from '../../redis/redis.service';
import { CylinderRecoveryCron } from './cylinder-recovery.cron';
import { CylinderRecoveryService } from './cylinder-recovery.service';
import { PARAMETROS } from './recovery-test-kit';

describe('CylinderRecoveryCron', () => {
  let recovery: {
    distribuidorasConEnvasesAfuera: jest.Mock;
    parametros: jest.Mock;
    ejecutar: jest.Mock;
  };
  let redis: { withLock: jest.Mock };
  let cron: CylinderRecoveryCron;
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
    cron = new CylinderRecoveryCron(
      recovery as unknown as CylinderRecoveryService,
      redis as unknown as RedisService,
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
});
