import { Logger } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { StoragePort } from './ports/storage.port';
import {
  StorageOrphan,
  StorageOrphanKind,
  StorageOrphanStatus,
} from './entities/storage-orphan.entity';
import {
  MAX_ORPHAN_ATTEMPTS,
  REMOVE_RETRY_DELAYS_MS,
  StorageCleanupService,
  UPLOAD_GRACE_MS,
} from './storage-cleanup.service';

describe('StorageCleanupService', () => {
  let storage: { remove: jest.Mock };
  let filas: Map<string, StorageOrphan>;
  let orphans: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
    upsert: jest.Mock;
  };
  let manager: { upsert: jest.Mock; delete: jest.Mock };
  let errorLog: jest.SpyInstance;
  let service: StorageCleanupService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    filas = new Map();
    storage = { remove: jest.fn().mockResolvedValue(undefined) };
    const upsert = (_e: unknown, o: Partial<StorageOrphan>) => {
      filas.set(
        o.storageKey as string,
        {
          attempts: 0,
          lastError: null,
          ...o,
        } as StorageOrphan,
      );
      return Promise.resolve({});
    };
    orphans = {
      find: jest.fn(() => Promise.resolve([...filas.values()])),
      findOne: jest.fn(({ where }: { where: { storageKey: string } }) =>
        Promise.resolve(filas.get(where.storageKey) ?? null),
      ),
      create: jest.fn((o: Partial<StorageOrphan>) => o as StorageOrphan),
      save: jest.fn((o: StorageOrphan) => {
        filas.set(o.storageKey, o);
        return Promise.resolve(o);
      }),
      delete: jest.fn((where: { storageKey?: string; orphanId?: string }) => {
        for (const [k, v] of filas) {
          if (k === where.storageKey || v.orphanId === where.orphanId) {
            filas.delete(k);
          }
        }
        return Promise.resolve({});
      }),
      upsert: jest.fn((o: Partial<StorageOrphan>) => upsert(null, o)),
    };
    manager = {
      upsert: jest.fn((e: unknown, o: Partial<StorageOrphan>) => upsert(e, o)),
      delete: jest.fn((_e: unknown, where: { storageKey: string }) => {
        filas.delete(where.storageKey);
        return Promise.resolve({});
      }),
    };
    service = new StorageCleanupService(
      storage as unknown as StoragePort,
      orphans as unknown as Repository<StorageOrphan>,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const sumaDeEsperas = REMOVE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);

  describe('registro de la intención', () => {
    it('reserveUpload anota la key como subida pendiente con una hora de gracia', async () => {
      await service.reserveUpload('k1');
      const fila = filas.get('k1');
      expect(fila).toMatchObject({
        kind: StorageOrphanKind.UPLOAD,
        status: StorageOrphanStatus.PENDING,
      });
      expect(fila!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
        Date.now() + UPLOAD_GRACE_MS - 1000,
      );
    });

    it('confirmUpload quita la reserva dentro de la transacción recibida', async () => {
      await service.reserveUpload('k1');
      await service.confirmUpload(manager as unknown as EntityManager, 'k1');
      expect(manager.delete).toHaveBeenCalledWith(StorageOrphan, {
        storageKey: 'k1',
      });
      expect(filas.has('k1')).toBe(false);
    });

    it('scheduleRemoval anota el borrado con el manager de la transacción, no con el repo', async () => {
      await service.scheduleRemoval(manager as unknown as EntityManager, 'k1');
      expect(manager.upsert).toHaveBeenCalledTimes(1);
      expect(orphans.upsert).not.toHaveBeenCalled();
      expect(filas.get('k1')).toMatchObject({
        kind: StorageOrphanKind.REMOVE,
        status: StorageOrphanStatus.PENDING,
      });
    });
  });

  describe('borrado en segundo plano', () => {
    it('si sale a la primera, quita la fila anotada', async () => {
      await service.scheduleRemoval(manager as unknown as EntityManager, 'k1');
      await service.removeWithRetry('k1');
      expect(storage.remove).toHaveBeenCalledTimes(1);
      expect(filas.has('k1')).toBe(false);
    });

    it('removeInBackground vuelve sin esperar al proveedor', () => {
      storage.remove.mockReturnValue(new Promise(() => undefined));
      expect(service.removeInBackground('k1')).toBeUndefined();
      expect(storage.remove).toHaveBeenCalledWith('k1');
    });

    it('reintenta con backoff y, cuando sale, la fila desaparece', async () => {
      await service.scheduleRemoval(manager as unknown as EntityManager, 'k1');
      storage.remove
        .mockRejectedValueOnce(new Error('S3 caído'))
        .mockRejectedValueOnce(new Error('S3 caído'))
        .mockResolvedValue(undefined);

      const corrida = service.removeWithRetry('k1');
      await jest.advanceTimersByTimeAsync(sumaDeEsperas);
      await corrida;

      expect(storage.remove).toHaveBeenCalledTimes(3);
      expect(filas.size).toBe(0);
    });

    it('agotados los intentos en proceso, la fila queda con el motivo y turno futuro para el cron', async () => {
      await service.scheduleRemoval(manager as unknown as EntityManager, 'k1');
      storage.remove.mockRejectedValue(new Error('S3 caído'));

      const corrida = service.removeWithRetry('k1');
      await jest.advanceTimersByTimeAsync(sumaDeEsperas);
      await corrida;

      expect(storage.remove).toHaveBeenCalledTimes(
        REMOVE_RETRY_DELAYS_MS.length + 1,
      );
      const fila = filas.get('k1')!;
      expect(fila.lastError).toContain('agotado');
      expect(fila.attempts).toBe(1);
      expect(fila.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('si el caller no anotó nada y el borrado falla, igual deja la fila', async () => {
      storage.remove.mockRejectedValue(new Error('S3 caído'));
      const corrida = service.removeWithRetry('k9');
      await jest.advanceTimersByTimeAsync(sumaDeEsperas);
      await corrida;
      expect(filas.get('k9')).toMatchObject({ storageKey: 'k9', attempts: 1 });
    });

    it('si ni la base responde, no lanza', async () => {
      storage.remove.mockRejectedValue(new Error('S3 caído'));
      orphans.findOne.mockRejectedValue(new Error('base caída'));
      const corrida = service.removeWithRetry('k1');
      await jest.advanceTimersByTimeAsync(sumaDeEsperas);
      await expect(corrida).resolves.toBeUndefined();
    });
  });

  describe('cron retryOrphans', () => {
    const fila = (over: Partial<StorageOrphan>): StorageOrphan =>
      ({
        orphanId: over.storageKey,
        kind: StorageOrphanKind.REMOVE,
        status: StorageOrphanStatus.PENDING,
        attempts: 0,
        lastError: null,
        nextAttemptAt: new Date(0),
        ...over,
      }) as StorageOrphan;

    it('pide sólo lo pendiente cuyo turno llegó, por orden de turno', async () => {
      await service.retryOrphans();
      const [arg] = orphans.find.mock.calls[0] as [
        { where: { status: string }; order: { nextAttemptAt: string } },
      ];
      expect(arg.where.status).toBe(StorageOrphanStatus.PENDING);
      expect(arg.order).toEqual({ nextAttemptAt: 'ASC' });
    });

    it('borra los que ahora sí salen y reprograma con backoff los que no', async () => {
      filas.set('ok', fila({ storageKey: 'ok', attempts: 4 }));
      filas.set('mal', fila({ storageKey: 'mal', attempts: 4 }));
      storage.remove.mockImplementation((key: string) =>
        key === 'ok'
          ? Promise.resolve()
          : Promise.reject(new Error('sigue caído')),
      );

      await service.retryOrphans();

      expect(filas.has('ok')).toBe(false);
      const mal = filas.get('mal')!;
      expect(mal).toMatchObject({
        attempts: 5,
        lastError: 'sigue caído',
        status: StorageOrphanStatus.PENDING,
      });
      expect(mal.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('al llegar al tope la marca fallida y loguea la key y el motivo', async () => {
      filas.set(
        'tope',
        fila({ storageKey: 'tope', attempts: MAX_ORPHAN_ATTEMPTS - 1 }),
      );
      storage.remove.mockRejectedValue(new Error('AccessDenied'));

      await service.retryOrphans();

      expect(filas.get('tope')!.status).toBe(StorageOrphanStatus.FAILED);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('tope'));
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('AccessDenied'),
      );
    });
  });
});
