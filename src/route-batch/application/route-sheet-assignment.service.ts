import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RoleType } from '../../common/constants/role-type.enum';
import { errorMessage } from '../../common/errors/error-message';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { DeliveryService } from '../../delivery/delivery.service';
import { OrderStatus } from '../../order/entities/order.entity';
import { RouteStopRemovedReason } from '../../order/entities/route-batch-stop.entity';
import { OrderService } from '../../order/order.service';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { RouteSheetNotifier } from './route-sheet-notifier.service';
import { RouteSheetWriter } from './route-sheet-writer.service';

export interface ResultadoDeAsignacion {
  sheetId: string;
  /** Los pedidos de la hoja que quedaron asignados al chofer (los de antes y los nuevos). */
  assignedOrderIds: string[];
  /** Los que ya no estaban disponibles y salieron de la hoja (`unavailable`). */
  droppedOrderIds: string[];
  /** La hoja no se asignó (no está confirmada, no es de hoy o no tiene chofer). */
  skipped: boolean;
}

interface FilaDePedido {
  orderId: string;
  status: OrderStatus;
  deliveryId: string | null;
}

/**
 * La hoja confirmada es del chofer (F34, rediseño del 14/11): sus pedidos
 * quedan asignados a él sin que tenga que aceptar nada. Se asignan el DÍA del
 * reparto —al confirmar una hoja de hoy, o al empezar el día para las que se
 * confirmaron antes—: asignarlos la víspera lo dejaría «ocupado» para el
 * despacho del día anterior. Se usa la asignación de siempre
 * (`assignDelivery`, que bloquea el pedido y genera el código de entrega) con
 * el vehículo de la hoja y saltando sólo la retención de ESTA hoja; los
 * controles de la jornada (carga, vehículo en uso) se validan al iniciar el
 * viaje. Un pedido que ya no está libre sale de la hoja (`unavailable`).
 */
@Injectable()
export class RouteSheetAssignmentService {
  private readonly logger = new Logger(RouteSheetAssignmentService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly locks: RouteSheetLocks,
    private readonly writer: RouteSheetWriter,
    private readonly orders: OrderService,
    private readonly deliveries: DeliveryService,
    private readonly notifier: RouteSheetNotifier,
  ) {}

  /** Con el cerrojo de la hoja (confirmar una de hoy, el proceso del día). */
  asignarHoja(
    distributorId: string,
    id: string,
    actorUserId: string | null,
  ): Promise<ResultadoDeAsignacion> {
    return this.locks.conCerrojo([id], () =>
      this.asignarConCerrojoTomado(distributorId, id, actorUserId),
    );
  }

  /** Quien llama ya tiene el cerrojo de la hoja (el inicio del viaje). */
  async asignarConCerrojoTomado(
    distributorId: string,
    id: string,
    actorUserId: string | null,
  ): Promise<ResultadoDeAsignacion> {
    const sheet = await this.locks.enTransaccion(
      distributorId,
      [{ id }],
      (_m, [fila]) => Promise.resolve(fila),
    );
    const omitida = {
      sheetId: id,
      assignedOrderIds: [],
      droppedOrderIds: [],
      skipped: true,
    };
    if (
      sheet.status !== RouteBatchStatus.CONFIRMED ||
      sheet.planDate !== diaArgentino() ||
      !sheet.deliveryId
    ) {
      return omitida;
    }
    const chofer = await this.deliveries.findById(sheet.deliveryId);
    if (!chofer) return omitida;
    const vehiculo = await this.vehiculo(sheet.carId as string);
    const paradas = await this.writer.paradasActivas(
      this.dataSource.manager,
      id,
      false,
    );
    const pedidos = await this.pedidos(paradas.map((p) => p.orderId));
    const asignados: string[] = [];
    const caidos: string[] = [];
    for (const parada of paradas) {
      const p = pedidos.get(parada.orderId);
      if (
        p?.deliveryId === chofer.deliveryId &&
        (p.status === OrderStatus.ACCEPTED ||
          p.status === OrderStatus.ON_THE_WAY)
      ) {
        asignados.push(parada.orderId);
        continue;
      }
      const ok = await this.asignar(
        parada.orderId,
        p?.status ?? null,
        id,
        chofer.deliveryId,
        distributorId,
        vehiculo,
        actorUserId,
      );
      (ok ? asignados : caidos).push(parada.orderId);
    }
    const primeraVez = await this.locks.enTransaccion(
      distributorId,
      [{ id }],
      async (manager, [fila]) => {
        for (const orderId of caidos) {
          await this.writer.apagarParada(
            manager,
            id,
            orderId,
            RouteStopRemovedReason.UNAVAILABLE,
          );
        }
        if (fila.assignedAt) return false;
        fila.assignedAt = new Date();
        await manager.save(fila);
        return true;
      },
    );
    if (primeraVez || caidos.length > 0) {
      this.notifier.alChofer(chofer.userId, 'route-sheet:assigned', {
        sheetId: id,
        orderIds: asignados,
        droppedOrderIds: caidos,
      });
      this.notifier.alPanel(distributorId, 'route-sheet:assigned', {
        sheetId: id,
        deliveryId: chofer.deliveryId,
        assignedOrders: asignados.length,
        droppedOrderIds: caidos,
      });
    }
    if (primeraVez) {
      void this.notifier.pushAlChofer(
        chofer.notificationToken,
        id,
        `Tenés tu hoja de ruta de hoy: ${asignados.length} entrega(s). Cuando tengas la carga, iniciá el viaje.`,
        'Tu hoja de ruta de hoy',
        'ROUTE_SHEET_ASSIGNED',
      );
    }
    return {
      sheetId: id,
      assignedOrderIds: asignados,
      droppedOrderIds: caidos,
      skipped: false,
    };
  }

  /**
   * Devuelve al despacho de la planificación los pedidos que la hoja le había
   * asignado al chofer (al reabrirla o cancelarla antes del viaje): vuelven a
   * pendientes sin chofer por el camino único de liberación.
   */
  async liberar(
    deliveryId: string | null,
    orderIds: readonly string[],
    actorUserId: string,
  ): Promise<string[]> {
    if (!deliveryId || orderIds.length === 0) return [];
    const pedidos = await this.pedidos(orderIds);
    const liberados: string[] = [];
    for (const orderId of orderIds) {
      const p = pedidos.get(orderId);
      if (p?.deliveryId !== deliveryId || p.status !== OrderStatus.ACCEPTED) {
        continue;
      }
      try {
        await this.orders.updateStatus(
          orderId,
          OrderStatus.PENDING,
          undefined,
          RoleType.ADMIN,
          actorUserId,
        );
        liberados.push(orderId);
      } catch (error) {
        this.logger.warn(
          `El pedido ${orderId} no se liberó al sacar la hoja: ${errorMessage(error)}`,
        );
      }
    }
    return liberados;
  }

  /** Las hojas confirmadas de hoy que todavía no se le asignaron al chofer (el proceso de cada minuto). */
  async asignarLasDeHoy(): Promise<number> {
    const hojas: Array<{ batchId: string; distributorId: string }> =
      await this.dataSource.query(
        `SELECT "batch_id" AS "batchId", "distributor_id" AS "distributorId" FROM "route_batch"
          WHERE "kind" = 'planned' AND "status" = 'confirmed' AND "assigned_at" IS NULL
            AND "plan_date" = $1::date`,
        [diaArgentino()],
      );
    let n = 0;
    for (const h of hojas) {
      try {
        const r = await this.asignarHoja(h.distributorId, h.batchId, null);
        if (!r.skipped) n += 1;
      } catch (error) {
        this.logger.warn(
          `Hoja ${h.batchId}: no se pudo asignar: ${errorMessage(error)}`,
        );
      }
    }
    return n;
  }

  /** `false` si el pedido ya no está libre (cancelado, de otro chofer, Mercado Pago sin pagar: D-06). */
  private async asignar(
    orderId: string,
    estado: OrderStatus | null,
    sheetId: string,
    deliveryId: string,
    distributorId: string,
    vehiculo: Awaited<ReturnType<RouteSheetAssignmentService['vehiculo']>>,
    actorUserId: string | null,
  ): Promise<boolean> {
    try {
      if (estado === OrderStatus.RESERVED) {
        // La reserva del día se activa por el camino de siempre (seña paga y día cumplido).
        await this.orders.updateStatus(
          orderId,
          OrderStatus.PENDING,
          undefined,
          RoleType.ADMIN,
          actorUserId ?? undefined,
        );
      }
      await this.orders.assignDelivery(orderId, deliveryId, distributorId, {
        soloSiLibre: true,
        hojaDeRuta: sheetId,
        vehiculoDeLaHoja: vehiculo,
      });
      return true;
    } catch (error) {
      const nivel = error instanceof ConflictException ? 'log' : 'warn';
      this.logger[nivel](
        `Hoja ${sheetId}: el pedido ${orderId} no se asignó: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  private async vehiculo(carId: string) {
    const [c]: Array<{
      carId: string;
      patent: string | null;
      brand: string | null;
      model: string | null;
    }> = await this.dataSource.query(
      `SELECT "car_id" AS "carId", "car_patent" AS "patent", "car_brand" AS "brand", "car_model" AS "model"
         FROM "car" WHERE "car_id" = $1`,
      [carId],
    );
    return {
      carId,
      patent: c?.patent ?? null,
      brand: c?.brand ?? null,
      model: c?.model ?? null,
    };
  }

  private async pedidos(
    orderIds: readonly string[],
  ): Promise<Map<string, FilaDePedido>> {
    if (orderIds.length === 0) return new Map();
    const filas: FilaDePedido[] = await this.dataSource.query(
      `SELECT "order_id" AS "orderId", "status"::text AS "status", "delivery_id" AS "deliveryId"
         FROM "order" WHERE "order_id" = ANY($1::uuid[])`,
      [orderIds],
    );
    return new Map(filas.map((f) => [f.orderId, f]));
  }
}
