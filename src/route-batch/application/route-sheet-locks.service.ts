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

/** Lo que la operación agrega a la hoja (además de las paradas que ya tiene). */
export interface OpcionesDeBloqueo {
  /**
   * Pedidos que entran a la hoja en esta operación: se bloquean `FOR UPDATE`
   * (el alta los relee y los valida), en orden de id junto con los de las
   * paradas, y una sola vez.
   */
  pedidosNuevos?: readonly string[];
}
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
    opciones: OpcionesDeBloqueo = {},
  ): Promise<T> {
    return this.conCerrojo(
      pedidas.map((p) => p.id),
      () => this.enTransaccion(distributorId, pedidas, fn, opciones),
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
    opciones: OpcionesDeBloqueo = {},
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
      await this.bloquearPedidos(
        manager,
        distributorId,
        ids,
        opciones.pedidosNuevos ?? [],
      );
      return fn(manager, hojas);
    });
  }

  /**
   * Orden de cerrojos de la hoja: hoja → pedidos → paradas. Con las hojas ya
   * bloqueadas y ANTES de que la operación toque sus paradas, toma los pedidos
   * de las paradas activas (`FOR KEY SHARE`) y los que entran (`FOR UPDATE`),
   * en orden de id. Es el orden de la propuesta y del alta de una hoja (hoja →
   * pedidos → paradas); la cancelación o entrega de un pedido toma pedido →
   * parada, un sufijo de ese orden.
   *
   * Sin esto, una operación que escribe dos veces la misma parada en su
   * transacción (recalcular después de activar, ordenar o confirmar) dispara en
   * la segunda la verificación de la FK `route_batch_stop.order_id`, que pide
   * `FOR KEY SHARE` del pedido teniendo ya la parada: si en ese instante se
   * cancela el pedido (`FOR UPDATE` del pedido y después su parada), deadlock
   * (40P01). `FOR KEY SHARE` es lo mismo que pediría la FK y sólo choca con
   * `FOR UPDATE`: no frena las actualizaciones comunes del pedido. Las paradas
   * no cambian entre la lectura y el bloqueo: agregar una exige el cerrojo de
   * la hoja, y sacarla (cancelación) sólo achica el conjunto.
   */
  async bloquearPedidos(
    manager: EntityManager,
    distributorId: string,
    hojas: readonly string[],
    pedidosNuevos: readonly string[],
  ): Promise<void> {
    if (pedidosNuevos.length === 0) {
      await manager.query(
        `SELECT o."order_id" FROM "order" o
          WHERE o."distributor_id" = $2
            AND o."order_id" IN (SELECT s."order_id" FROM "route_batch_stop" s
                                  WHERE s."batch_id" = ANY($1::uuid[]) AND s."active")
          ORDER BY o."order_id"
          FOR KEY SHARE OF o`,
        [hojas, distributorId],
      );
      return;
    }
    const filas: Array<{ orderId: string }> = await manager.query(
      `SELECT DISTINCT s."order_id" AS "orderId" FROM "route_batch_stop" s
        WHERE s."batch_id" = ANY($1::uuid[]) AND s."active"`,
      [hojas],
    );
    const nuevos = new Set(pedidosNuevos);
    const todos = [
      ...new Set([...filas.map((f) => f.orderId), ...nuevos]),
    ].sort();
    for (const orderId of todos) {
      await manager.query(
        `SELECT o."order_id" FROM "order" o
          WHERE o."order_id" = $1 AND o."distributor_id" = $2
          ${nuevos.has(orderId) ? 'FOR UPDATE OF o' : 'FOR KEY SHARE OF o'}`,
        [orderId, distributorId],
      );
    }
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
