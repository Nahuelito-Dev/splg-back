import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import Decimal from 'decimal.js';
import { CustomerContainerMovementReason } from './entities/customer-container-movement.entity';
import { CustomerContainerResponseDto } from './dto/customer-container-response.dto';
import { CustomerContainerMovementsResponseDto } from './dto/customer-container-movements-response.dto';

export interface RegistrarMovimientoDeEnvases {
  distributorId: string;
  customerUserId: string;
  gasCylinderId: string;
  quantity: number;
  reason: CustomerContainerMovementReason;
  orderId?: string;
  note?: string;
  actorUserId?: string;
}

interface CuentaFila {
  account_id: string;
  owned: number;
}

export interface EnvaseACobrar {
  gasCylinderId: string;
  quantity: number;
  containerPrice: number | null;
  type: string;
}

export interface CargoDeEnvase {
  gasCylinderId: string;
  containersCharged: number;
  containerUnitPrice: number | null;
  containerSubtotal: Decimal;
}

interface FilaDeMovimiento {
  movement_id: string;
  gas_cylinder_id: string;
  type: string;
  quantity: number;
  reason: CustomerContainerMovementsResponseDto['items'][number]['reason'];
  order_id: string | null;
  note: string | null;
  actor_user_id: string | null;
  created_at: Date;
  total: string;
}

@Injectable()
export class CustomerContainerService {
  /** Calcula los envases que el cliente debe comprar para este pedido. */
  async envasesACobrar(
    manager: EntityManager,
    distributorId: string,
    customerUserId: string,
    items: EnvaseACobrar[],
    excludeOrderId?: string,
  ): Promise<CargoDeEnvase[]> {
    if (items.length === 0) return [];
    const filas: Array<{
      gas_cylinder_id: string;
      owned: number;
      committed: number;
    }> = await manager.query(
      // Los comprometidos se suman sólo sobre los pedidos abiertos del cliente (no sobre todo
      // el histórico del tipo): esta consulta corre con el FOR UPDATE de gas_cylinder tomado.
      `SELECT i.gas_cylinder_id, COALESCE(a.owned, 0)::int AS owned,
              COALESCE(c.committed, 0)::int AS committed
       FROM UNNEST($3::uuid[]) AS i(gas_cylinder_id)
       LEFT JOIN customer_container_account a
         ON a.distributor_id = $1 AND a.customer_user_id = $2
        AND a.gas_cylinder_id = i.gas_cylinder_id
       LEFT JOIN (
         SELECT oi.gas_cylinder_id, SUM(oi.quantity - oi.containers_charged) AS committed
         FROM "order" o
         JOIN order_item oi ON oi.order_id = o.order_id
         WHERE o.distributor_id = $1 AND o.customer_id = $2
           AND o.status IN ('reserved', 'pending', 'accepted', 'on_the_way')
           AND ($4::uuid IS NULL OR o.order_id <> $4::uuid)
           AND oi.gas_cylinder_id = ANY($3::uuid[])
         GROUP BY oi.gas_cylinder_id
       ) c ON c.gas_cylinder_id = i.gas_cylinder_id`,
      [
        distributorId,
        customerUserId,
        items.map((item) => item.gasCylinderId),
        excludeOrderId ?? null,
      ],
    );
    const saldos = new Map(filas.map((fila) => [fila.gas_cylinder_id, fila]));
    return items.map((item) => {
      const fila = saldos.get(item.gasCylinderId);
      const disponibles = Math.max(
        0,
        Number(fila?.owned ?? 0) - Number(fila?.committed ?? 0),
      );
      const containersCharged = Math.max(0, item.quantity - disponibles);
      if (containersCharged > 0 && item.containerPrice === null) {
        // El tipo es el nombre comercial de la garrafa («Garrafa 10kg»), no un nombre interno.
        const nombreComercial = item.type;
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          message: `La distribuidora todavía no cargó el precio del envase de ${nombreComercial}: no se puede tomar el pedido`,
          code: 'CONTAINER_PRICE_MISSING',
        });
      }
      const price =
        item.containerPrice === null ? null : new Decimal(item.containerPrice);
      return {
        gasCylinderId: item.gasCylinderId,
        containersCharged,
        containerUnitPrice: price?.toNumber() ?? null,
        containerSubtotal: price?.times(containersCharged) ?? new Decimal(0),
      };
    });
  }

  async registrar(
    manager: EntityManager,
    datos: RegistrarMovimientoDeEnvases,
  ): Promise<number> {
    await manager.query(
      `INSERT INTO customer_container_account
        (distributor_id, customer_user_id, gas_cylinder_id, owned)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT (distributor_id, customer_user_id, gas_cylinder_id) DO NOTHING`,
      [datos.distributorId, datos.customerUserId, datos.gasCylinderId],
    );
    const [cuentaActual]: CuentaFila[] = await manager.query(
      `SELECT account_id, owned FROM customer_container_account
       WHERE distributor_id = $1 AND customer_user_id = $2 AND gas_cylinder_id = $3`,
      [datos.distributorId, datos.customerUserId, datos.gasCylinderId],
    );
    const movimiento: Array<{ account_id: string }> = await manager.query(
      `INSERT INTO customer_container_movement
        (account_id, distributor_id, quantity, reason, order_id, note, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (account_id, order_id) WHERE reason = 'purchased' DO NOTHING
       RETURNING account_id`,
      [
        cuentaActual.account_id,
        datos.distributorId,
        datos.quantity,
        datos.reason,
        datos.orderId ?? null,
        datos.note ?? null,
        datos.actorUserId ?? null,
      ],
    );
    if (
      datos.reason === CustomerContainerMovementReason.PURCHASED &&
      movimiento.length === 0
    ) {
      const [cuenta]: CuentaFila[] = await manager.query(
        `SELECT account_id, owned FROM customer_container_account
         WHERE distributor_id = $1 AND customer_user_id = $2 AND gas_cylinder_id = $3`,
        [datos.distributorId, datos.customerUserId, datos.gasCylinderId],
      );
      return cuenta.owned;
    }
    // Con Postgres, un UPDATE … RETURNING devuelve [filas, cantidad], no las filas.
    const [actualizada]: [CuentaFila[], number] = await manager.query(
      `UPDATE customer_container_account
       SET owned = owned + $1, updated_at = now()
       WHERE distributor_id = $2 AND customer_user_id = $3 AND gas_cylinder_id = $4
         AND owned + $1 >= 0
       RETURNING account_id, owned`,
      [
        datos.quantity,
        datos.distributorId,
        datos.customerUserId,
        datos.gasCylinderId,
      ],
    );
    const cuenta = actualizada[0];
    if (!cuenta) {
      throw new ConflictException('El cliente quedaría con envases negativos');
    }
    return cuenta.owned;
  }

  async inicializarSaldoDesdeEntregas(manager: EntityManager): Promise<void> {
    // Dos sentencias: en una sola, el UPDATE final no ve las cuentas que insertó una CTE anterior.
    await manager.query(`
      WITH maximos AS (
        SELECT o.distributor_id, o.customer_id, oi.gas_cylinder_id,
               MAX(oi.quantity)::int AS owned
        FROM "order" o
        JOIN order_item oi ON oi.order_id = o.order_id
        WHERE o.status = 'delivered'
        GROUP BY o.distributor_id, o.customer_id, oi.gas_cylinder_id
      )
      INSERT INTO customer_container_account
        (distributor_id, customer_user_id, gas_cylinder_id)
      SELECT distributor_id, customer_id, gas_cylinder_id FROM maximos
      ON CONFLICT (distributor_id, customer_user_id, gas_cylinder_id) DO NOTHING
    `);
    await manager.query(`
      WITH maximos AS (
        SELECT o.distributor_id, o.customer_id, oi.gas_cylinder_id,
               MAX(oi.quantity)::int AS owned
        FROM "order" o
        JOIN order_item oi ON oi.order_id = o.order_id
        WHERE o.status = 'delivered'
        GROUP BY o.distributor_id, o.customer_id, oi.gas_cylinder_id
      ), iniciales AS (
        INSERT INTO customer_container_movement
          (account_id, distributor_id, quantity, reason)
        SELECT a.account_id, a.distributor_id, m.owned, 'initial_from_deliveries'
        FROM customer_container_account a
        JOIN maximos m ON m.distributor_id = a.distributor_id
          AND m.customer_id = a.customer_user_id
          AND m.gas_cylinder_id = a.gas_cylinder_id
        WHERE m.owned > 0
        ON CONFLICT (account_id) WHERE reason = 'initial_from_deliveries'
          DO NOTHING
        RETURNING account_id, quantity
      )
      UPDATE customer_container_account a
      SET owned = a.owned + i.quantity, updated_at = now()
      FROM iniciales i
      WHERE a.account_id = i.account_id
    `);
  }

  async listar(
    manager: EntityManager,
    distributorId: string,
    customerUserId: string,
  ): Promise<CustomerContainerResponseDto[]> {
    return manager.query(
      `SELECT g.gas_cylinder_id AS "gasCylinderId", g.type,
              COALESCE(a.owned, 0)::int AS owned, g."isActive" AS "isActive",
              COUNT(c.cylinder_id) FILTER (WHERE c.state = 'with_customer')::int AS "loanedByM5"
       FROM gas_cylinder g
       LEFT JOIN customer_container_account a ON a.distributor_id = g.distributor_id
         AND a.gas_cylinder_id = g.gas_cylinder_id AND a.customer_user_id = $2
       LEFT JOIN cylinder c ON c.distributor_id = g.distributor_id
         AND c.gas_cylinder_id = g.gas_cylinder_id AND c.current_customer_id = $2
       WHERE g.distributor_id = $1
       GROUP BY g.gas_cylinder_id, g.type, a.owned, g."isActive"
       HAVING g."isActive" = true OR COALESCE(a.owned, 0) > 0
         OR COUNT(c.cylinder_id) FILTER (WHERE c.state = 'with_customer') > 0
       ORDER BY g.type ASC`,
      [distributorId, customerUserId],
    );
  }

  async listarMovimientos(
    manager: EntityManager,
    distributorId: string,
    customerUserId: string,
    limit: number,
    offset: number,
  ): Promise<CustomerContainerMovementsResponseDto> {
    const filas: Array<FilaDeMovimiento> = await manager.query(
      `SELECT m.movement_id, a.gas_cylinder_id, g.type,
                m.quantity, m.reason, m.order_id, m.note,
                m.actor_user_id, m.created_at,
                count(*) OVER() AS total
         FROM customer_container_movement m
         JOIN customer_container_account a ON a.account_id = m.account_id
           AND a.distributor_id = m.distributor_id
         JOIN gas_cylinder g ON g.gas_cylinder_id = a.gas_cylinder_id
           AND g.distributor_id = a.distributor_id
         WHERE m.distributor_id = $1 AND a.customer_user_id = $2
         ORDER BY m.created_at DESC, m.movement_id DESC
         LIMIT $3 OFFSET $4`,
      [distributorId, customerUserId, limit, offset],
    );
    return {
      items: filas.map((fila) => ({
        movementId: fila.movement_id,
        gasCylinderId: fila.gas_cylinder_id,
        type: fila.type,
        quantity: fila.quantity,
        reason: fila.reason,
        orderId: fila.order_id,
        note: fila.note,
        actorUserId: fila.actor_user_id,
        createdAt: fila.created_at,
      })),
      total: filas[0] ? Number(filas[0].total) : 0,
      limit,
      offset,
    };
  }

  async asegurarTipoDeLaDistribuidora(
    manager: EntityManager,
    distributorId: string,
    gasCylinderId: string,
  ): Promise<void> {
    const filas: Array<{ existe: boolean }> = await manager.query(
      `SELECT EXISTS(SELECT 1 FROM gas_cylinder
        WHERE gas_cylinder_id = $1 AND distributor_id = $2) AS existe`,
      [gasCylinderId, distributorId],
    );
    if (!filas[0]?.existe)
      throw new NotFoundException('Tipo de envase no encontrado');
  }

  async ajuste(
    manager: EntityManager,
    datos: RegistrarMovimientoDeEnvases,
  ): Promise<CustomerContainerResponseDto> {
    await this.asegurarTipoDeLaDistribuidora(
      manager,
      datos.distributorId,
      datos.gasCylinderId,
    );
    await this.registrar(manager, datos);
    const tipos = await this.listar(
      manager,
      datos.distributorId,
      datos.customerUserId,
    );
    const tipo = tipos.find(
      (item) => item.gasCylinderId === datos.gasCylinderId,
    );
    if (!tipo) throw new NotFoundException('Tipo de envase no encontrado');
    return tipo;
  }
}
