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
 * Concurrencia de la edición (ADR-05): el cerrojo Redis renovable de cada hoja (el mismo
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
    return this.conCerrojo(
      pedidas.map((p) => p.id),
      () => this.enTransaccion(distributorId, pedidas, fn),
    );
  }

  /**
   * Sólo el cerrojo Redis de las hojas (en orden de id). Para las operaciones
   * que, como el inicio de la hoja, llaman a casos de uso con su propia
   * transacción (la asignación de cada pedido) y después abren la de la hoja
   * con `enTransaccion`, sin soltar el cerrojo en el medio.
   */
  async conCerrojo<T>(
    hojas: readonly string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const ids = [...new Set(hojas)].sort();
    return this.conCerrojosRenovables(ids, 0, fn);
  }

  /**
   * La transacción con las filas de las hojas bloqueadas (en orden de id) y la
   * versión optimista. Quien llama ya tiene el cerrojo Redis (`conCerrojo`).
   */
  enTransaccion<T>(
    distributorId: string,
    pedidas: ReadonlyArray<{ id: string; version?: number }>,
    fn: (manager: EntityManager, hojas: RouteBatch[]) => Promise<T>,
  ): Promise<T> {
    const ids = [...new Set(pedidas.map((p) => p.id))].sort();
    return this.dataSource.transaction(async (manager) => {
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
  }

  private async conCerrojosRenovables<T>(
    ids: readonly string[],
    indice: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (indice === ids.length) return fn();
    const resultado = await this.redis.withLock(
      `route-batch:${ids[indice]}`,
      CERROJO_TTL_MS,
      () => this.conCerrojosRenovables(ids, indice + 1, fn),
      ESPERA_DEL_CERROJO_MS,
    );
    if (!resultado.obtenido) throw hojaOcupada();
    return resultado.valor;
  }
}
