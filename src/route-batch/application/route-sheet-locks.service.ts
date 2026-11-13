import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import { RedisService } from '../../redis/redis.service';
import { RouteBatchKind } from '../domain/route-batch.enums';
import { versionVigente } from '../domain/route-sheet-rules';
import {
  hojaNoEncontrada,
  hojaOcupada,
  versionVieja,
} from './route-sheet.exceptions';

const CERROJO_TTL_MS = 30_000;
const ESPERA_DEL_CERROJO_MS = 3_000;

/**
 * Concurrencia de la edición (ADR-05): el cerrojo Redis de cada hoja (el mismo
 * `route-batch:<id>` de M4), la transacción con la fila bloqueada y la versión
 * optimista que mandó quien edita. Con dos hojas, los cerrojos se toman en
 * orden de id (sin interbloqueo).
 */
@Injectable()
export class RouteSheetLocks {
  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  async conHojas<T>(
    distributorId: string,
    pedidas: ReadonlyArray<{ id: string; version?: number }>,
    fn: (manager: EntityManager, hojas: RouteBatch[]) => Promise<T>,
  ): Promise<T> {
    const ids = [...new Set(pedidas.map((p) => p.id))].sort();
    const cerrojos = [];
    try {
      for (const id of ids) {
        const lock = await this.esperarCerrojo(`route-batch:${id}`);
        if (!lock) throw hojaOcupada();
        cerrojos.push(lock);
      }
      return await this.dataSource.transaction(async (manager) => {
        const filas = await manager.find(RouteBatch, {
          where: {
            batchId: In(ids),
            distributorId,
            kind: RouteBatchKind.PLANNED,
          },
          order: { batchId: 'ASC' },
          lock: { mode: 'pessimistic_write' },
        });
        const porId = new Map(filas.map((f) => [f.batchId, f]));
        const hojas = pedidas.map((p) => {
          const hoja = porId.get(p.id);
          if (!hoja) throw hojaNoEncontrada();
          if (
            p.version !== undefined &&
            !versionVigente(hoja.version, p.version)
          ) {
            throw versionVieja();
          }
          return hoja;
        });
        return fn(manager, hojas);
      });
    } finally {
      for (const lock of cerrojos.reverse()) {
        await lock.release().catch(() => undefined);
      }
    }
  }

  private async esperarCerrojo(clave: string) {
    const hasta = Date.now() + ESPERA_DEL_CERROJO_MS;
    for (;;) {
      const lock = await this.redis.acquireLock(clave, CERROJO_TTL_MS);
      if (lock || Date.now() >= hasta) return lock;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
