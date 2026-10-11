import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import {
  EntregaDePedido,
  StockDeliveryPort,
} from '../../order/domain/ports/stock-delivery.port';
import {
  MovimientoDeStock,
  StockLedgerPort,
} from '../domain/ports/stock-ledger.port';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../domain/stock.enums';
import { StockLocationService } from './stock-location.service';
import { WarehouseService } from './warehouse.service';

const INTENTOS = 3;
const DEADLOCK = '40P01';

function codigoDe(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { code?: unknown; driverError?: { code?: unknown } };
  const codigo = e.code ?? e.driverError?.code;
  return typeof codigo === 'string' ? codigo : undefined;
}

export type OrigenDeLaEntrega = 'vehiculo' | 'deposito';

export interface ResultadoDeEntrega {
  /** Garrafas cuyo físico se descontó en esta llamada, con el origen elegido. */
  aplicadas: Array<{ gasCylinderId: string; origen: OrigenDeLaEntrega }>;
  /** Garrafas que no se pudieron descontar (sin saldo, o error). */
  omitidas: string[];
}

/**
 * Efecto de la entrega de un pedido sobre el stock físico (D5 y D6):
 *  - sale la llena del camión del chofer si ese vehículo tiene saldo; si no, del
 *    depósito predeterminado;
 *  - entra una vacía al mismo lugar (canje 1 a 1, que se corrige al rendir);
 *  - el vendible no se toca: ya se descontó al reservar.
 *
 * Idempotente por pedido y garrafa (índice único del libro + chequeo previo).
 * Corre en la transacción del pedido, dentro de un savepoint: si falla, la
 * entrega sigue y queda registrado para la conciliación.
 */
@Injectable()
export class StockDeliveryService extends StockDeliveryPort {
  private readonly logger = new Logger(StockDeliveryService.name);

  constructor(
    private readonly ledger: StockLedgerPort,
    private readonly locations: StockLocationService,
    private readonly warehouses: WarehouseService,
  ) {
    super();
  }

  async onOrderDelivered(
    manager: EntityManager,
    entrega: EntregaDePedido,
  ): Promise<void> {
    await this.registrarEntrega(manager, entrega);
  }

  async registrarEntrega(
    manager: EntityManager,
    entrega: EntregaDePedido,
  ): Promise<ResultadoDeEntrega> {
    const todas = [...new Set(entrega.items.map((i) => i.gasCylinderId))];
    for (let intento = 1; intento <= INTENTOS; intento++) {
      try {
        // Todo adentro de un savepoint (lecturas y escritura): un fallo, sea de
        // lectura o un deadlock, no puede abortar la transacción del pedido.
        return await manager.transaction((m) => this.intentar(m, entrega));
      } catch (error) {
        if (codigoDe(error) === DEADLOCK && intento < INTENTOS) {
          await new Promise((r) => setTimeout(r, 25 * intento));
          continue;
        }
        this.logger.warn(
          `Pedido ${entrega.orderId}: no se pudo descontar el físico: ${errorMessage(error)}`,
        );
        return { aplicadas: [], omitidas: todas };
      }
    }
    return { aplicadas: [], omitidas: todas };
  }

  private async intentar(
    manager: EntityManager,
    entrega: EntregaDePedido,
  ): Promise<ResultadoDeEntrega> {
    const resultado: ResultadoDeEntrega = { aplicadas: [], omitidas: [] };
    {
      // Por garrafa y en orden de id: es el orden de locks.
      const pedido = new Map<string, number>();
      for (const item of entrega.items) {
        pedido.set(
          item.gasCylinderId,
          (pedido.get(item.gasCylinderId) ?? 0) + item.quantity,
        );
      }
      const hechos = await this.yaRegistrados(manager, entrega.orderId);
      const pendientes = [...pedido]
        .filter(([id]) => !hechos.has(id))
        .sort(([a], [b]) => a.localeCompare(b));
      if (pendientes.length === 0) return resultado;

      const deposito = await this.warehouses.asegurarPredeterminado(
        entrega.distributorId,
        manager,
      );
      const camion = entrega.vehicleCarId
        ? await this.locations.ubicacionExistenteDeVehiculo(
            manager,
            entrega.distributorId,
            entrega.vehicleCarId,
          )
        : null;
      const llenas = await this.llenasPorUbicacion(
        manager,
        [deposito.locationId, camion?.locationId].filter(
          (id): id is string => id !== undefined,
        ),
        pendientes.map(([id]) => id),
      );

      const movimientos: MovimientoDeStock[] = [];
      for (const [gasCylinderId, cantidad] of pendientes) {
        const origen = this.elegirOrigen(
          llenas,
          camion?.locationId,
          deposito.locationId,
          gasCylinderId,
          cantidad,
        );
        if (!origen) {
          resultado.omitidas.push(gasCylinderId);
          this.logger.warn(
            `Pedido ${entrega.orderId}: sin llenas suficientes de ${gasCylinderId} en el camión ni en el depósito; el físico no se descontó`,
          );
          continue;
        }
        const locationId =
          origen === 'vehiculo' ? camion!.locationId : deposito.locationId;
        movimientos.push(
          {
            gasCylinderId,
            quantity: cantidad,
            from: { locationId, condition: StockCondition.FULL },
            to: null,
            reason: StockMovementReason.DELIVERY,
          },
          {
            gasCylinderId,
            quantity: cantidad,
            from: null,
            to: { locationId, condition: StockCondition.EMPTY },
            reason: StockMovementReason.EMPTY_COLLECTED,
          },
        );
        resultado.aplicadas.push({ gasCylinderId, origen });
      }
      if (movimientos.length === 0) return resultado;

      await this.ledger.aplicar(manager, {
        distributorId: entrega.distributorId,
        referenceType: StockReferenceType.ORDER,
        referenceId: entrega.orderId,
        actorUserId: null,
        vendible: 'sin-cambio',
        movimientos,
      });
    }
    return resultado;
  }

  private elegirOrigen(
    llenas: Map<string, number>,
    camionId: string | undefined,
    depositoId: string,
    gasCylinderId: string,
    cantidad: number,
  ): OrigenDeLaEntrega | null {
    if (
      camionId &&
      (llenas.get(`${camionId}|${gasCylinderId}`) ?? 0) >= cantidad
    ) {
      return 'vehiculo';
    }
    if ((llenas.get(`${depositoId}|${gasCylinderId}`) ?? 0) >= cantidad) {
      return 'deposito';
    }
    return null;
  }

  private async yaRegistrados(
    manager: EntityManager,
    orderId: string,
  ): Promise<Set<string>> {
    const filas: Array<{ gas_cylinder_id: string }> = await manager.query(
      `SELECT "gas_cylinder_id" FROM "stock_movement"
       WHERE "reference_type" = 'order' AND "reference_id" = $1 AND "reason" = 'delivery'`,
      [orderId],
    );
    return new Set(filas.map((f) => f.gas_cylinder_id));
  }

  /** Llenas por `ubicación|garrafa`, leídas sin lock (la validación firme la hace el libro). */
  private async llenasPorUbicacion(
    manager: EntityManager,
    locationIds: string[],
    gasCylinderIds: string[],
  ): Promise<Map<string, number>> {
    const filas: Array<{
      location_id: string;
      gas_cylinder_id: string;
      quantity: number;
    }> = await manager.query(
      `SELECT "location_id", "gas_cylinder_id", "quantity" FROM "stock_balance"
       WHERE "location_id" = ANY($1::uuid[]) AND "gas_cylinder_id" = ANY($2::uuid[])
         AND "condition" = 'full'`,
      [locationIds, gasCylinderIds],
    );
    return new Map(
      filas.map((f) => [`${f.location_id}|${f.gas_cylinder_id}`, f.quantity]),
    );
  }
}
