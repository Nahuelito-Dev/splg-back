import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { rangoDeDiasArgentinos } from '../../common/utils/dias-argentina';
import { DeliveryService } from '../../delivery/delivery.service';
import {
  PaymentMethod,
  PaymentStatus,
} from '../../order/entities/order.entity';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { StockOnHandService } from '../../stock/application/stock-on-hand.service';
import { StockQueryService } from '../../stock/application/stock-query.service';
import { StockReferenceType } from '../../stock/domain/stock.enums';
import { CargaNoEncontradaError } from '../domain/errors/truck-load.errors';
import { ESTADOS_ABIERTOS, TruckLoadStatus } from '../domain/truck-load.enums';
import {
  diferenciaDe,
  entregasTardias,
  esperadoDe,
  planDeCierre,
  renglonesDeCierre,
  saldoACobrar,
} from '../domain/truck-load-rules';
import {
  MyTruckLoadDto,
  QueryTruckLoadDto,
  TruckLoadCashDto,
  TruckLoadItemResponseDto,
  TruckLoadOrderDto,
  TruckLoadPageDto,
  TruckLoadResponseDto,
  TruckLoadSummaryDto,
  TruckStockDto,
} from '../dto/truck-load.dto';
import { StockControlSettingsService } from './stock-control-settings.service';

interface FilaDeCarga {
  load_id: string;
  number: number;
  status: TruckLoadStatus;
  business_date: string;
  car_id: string;
  car_patent: string | null;
  delivery_id: string;
  driver_name: string;
  helper_employee_id: string | null;
  helper_name: string | null;
  origin_warehouse_id: string | null;
  origin_location_id: string;
  origin_name: string;
  opened_at: Date;
  departed_at: Date | null;
  returned_at: Date | null;
  closed_at: Date | null;
  items_count: number;
  difference_note: string | null;
  cancel_reason: string | null;
  notes: string | null;
  opened_by_user_id: string;
  created_at: Date;
}

interface FilaDeRenglon {
  item_id: string;
  gas_cylinder_id: string;
  type: string;
  loaded_full: number;
  reloaded_full: number;
  loaded_empty: number;
  declared_return_full: number | null;
  declared_return_empty: number | null;
  delivered_full: number | null;
  collected_empty: number | null;
  expected_full: number | null;
  expected_empty: number | null;
  difference_full: number | null;
  difference_empty: number | null;
}

const SELECT_CARGA = `
  SELECT l."load_id", l."number", l."status", l."business_date"::text AS business_date,
         l."car_id", c."car_patent", l."delivery_id", du."full_name" AS driver_name,
         l."helper_employee_id", NULLIF(TRIM(COALESCE(e."first_name", '') || ' ' || COALESCE(e."last_name", '')), '') AS helper_name,
         ol."warehouse_id" AS origin_warehouse_id, l."origin_location_id",
         COALESCE(w."name", 'Depósito') AS origin_name,
         l."opened_at", l."departed_at", l."returned_at", l."closed_at",
         (SELECT COUNT(*)::int FROM "truck_load_item" i WHERE i."load_id" = l."load_id") AS items_count,
         l."difference_note", l."cancel_reason", l."notes", l."opened_by_user_id", l."createdAt" AS created_at
  FROM "truck_load" l
  JOIN "car" c ON c."car_id" = l."car_id"
  JOIN "delivery" d ON d."delivery_id" = l."delivery_id"
  JOIN "user" du ON du."user_id" = d."user_id"
  LEFT JOIN "employee" e ON e."employee_id" = l."helper_employee_id"
  JOIN "stock_location" ol ON ol."location_id" = l."origin_location_id"
  LEFT JOIN "warehouse" w ON w."warehouse_id" = ol."warehouse_id"`;

function resumen(f: FilaDeCarga): TruckLoadSummaryDto {
  return {
    loadId: f.load_id,
    number: f.number,
    status: f.status,
    businessDate: f.business_date,
    carId: f.car_id,
    carPatent: f.car_patent,
    deliveryId: f.delivery_id,
    driverName: f.driver_name,
    helperEmployeeId: f.helper_employee_id,
    helperName: f.helper_name,
    originWarehouseId: f.origin_warehouse_id,
    originName: f.origin_name,
    openedAt: f.opened_at,
    departedAt: f.departed_at,
    returnedAt: f.returned_at,
    closedAt: f.closed_at,
    itemsCount: f.items_count,
  };
}

/** Lecturas del módulo: listado, detalle con esperado en vivo, "mi carga" y stock del camión. */
@Injectable()
export class TruckLoadQueryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orders: OrderLookupService,
    private readonly stockQuery: StockQueryService,
    private readonly onHand: StockOnHandService,
    private readonly deliveries: DeliveryService,
    private readonly settings: StockControlSettingsService,
  ) {}

  async listar(
    distributorId: string,
    query: QueryTruckLoadDto,
    alcance?: string,
  ): Promise<TruckLoadPageDto> {
    const params: unknown[] = [distributorId];
    const where = ['l."distributor_id" = $1'];
    const agregar = (condicion: (n: number) => string, valor: unknown) => {
      params.push(valor);
      where.push(condicion(params.length));
    };
    if (alcance) agregar((n) => `l."delivery_id" = $${n}`, alcance);
    if (query.status) agregar((n) => `l."status" = $${n}`, query.status);
    if (query.carId) agregar((n) => `l."car_id" = $${n}`, query.carId);
    if (query.deliveryId) {
      agregar((n) => `l."delivery_id" = $${n}`, query.deliveryId);
    }
    if (query.date) agregar((n) => `l."business_date" = $${n}`, query.date);
    if (query.from || query.to) {
      const desde = query.from ?? query.to!;
      const hasta = query.to ?? query.from!;
      if (!rangoDeDiasArgentinos(desde, hasta)) {
        throw new BadRequestException('Las fechas tienen que ser YYYY-MM-DD');
      }
      if (desde > hasta) {
        throw new BadRequestException('"from" no puede ser posterior a "to"');
      }
      agregar((n) => `l."business_date" >= $${n}`, desde);
      agregar((n) => `l."business_date" <= $${n}`, hasta);
    }
    const limit = query.limit ?? 10;
    const offset = ((query.page ?? 1) - 1) * limit;
    const [{ total }]: Array<{ total: string }> = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM "truck_load" l WHERE ${where.join(' AND ')}`,
      params,
    );
    const filas: FilaDeCarga[] = await this.dataSource.query(
      `${SELECT_CARGA}
       WHERE ${where.join(' AND ')}
       ORDER BY l."business_date" DESC, l."number" DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { data: filas.map(resumen), total: Number(total) };
  }

  async detalle(
    id: string,
    distributorId: string,
    alcance?: string,
  ): Promise<TruckLoadResponseDto> {
    const [fila]: FilaDeCarga[] = await this.dataSource.query(
      `${SELECT_CARGA} WHERE l."load_id" = $1 AND l."distributor_id" = $2`,
      [id, distributorId],
    );
    if (!fila || (alcance !== undefined && fila.delivery_id !== alcance)) {
      throw new CargaNoEncontradaError(id);
    }
    const abierta = ESTADOS_ABIERTOS.includes(fila.status);
    const renglones: FilaDeRenglon[] = await this.dataSource.query(
      `SELECT i."item_id", i."gas_cylinder_id", gc."type", i."loaded_full", i."reloaded_full", i."loaded_empty",
              i."declared_return_full", i."declared_return_empty", i."delivered_full", i."collected_empty",
              i."expected_full", i."expected_empty", i."difference_full", i."difference_empty"
       FROM "truck_load_item" i
       JOIN "gas_cylinder" gc ON gc."gas_cylinder_id" = i."gas_cylinder_id"
       WHERE i."load_id" = $1
       ORDER BY gc."type"`,
      [id],
    );
    const [ubicacion]: Array<{ location_id: string }> =
      await this.dataSource.query(
        `SELECT "location_id" FROM "stock_location" WHERE "car_id" = $1`,
        [fila.car_id],
      );
    const enElCamion = new Map<string, number>();
    const conSaldo = new Set<string>();
    const vivos = new Map<
      string,
      { deliveredFull: number; collectedEmpty: number }
    >();
    if (ubicacion) {
      const saldos: Array<{
        gas_cylinder_id: string;
        condition: string;
        quantity: number;
      }> = await this.dataSource.query(
        `SELECT "gas_cylinder_id", "condition", "quantity" FROM "stock_balance"
         WHERE "location_id" = $1 AND "quantity" > 0`,
        [ubicacion.location_id],
      );
      for (const s of saldos) {
        enElCamion.set(`${s.gas_cylinder_id}|${s.condition}`, s.quantity);
        conSaldo.add(s.gas_cylinder_id);
      }
      if (abierta) {
        for (const m of await this.onHand.movimientosDelCamion(
          this.dataSource.manager,
          ubicacion.location_id,
          fila.opened_at,
        )) {
          vivos.set(m.gasCylinderId, m);
        }
      }
    }

    const items: TruckLoadItemResponseDto[] = renglones.map((r) => {
      const congelado = r.expected_full !== null;
      const entregadas = congelado
        ? (r.delivered_full ?? 0)
        : (vivos.get(r.gas_cylinder_id)?.deliveredFull ?? 0);
      const recolectadas = congelado
        ? (r.collected_empty ?? 0)
        : (vivos.get(r.gas_cylinder_id)?.collectedEmpty ?? 0);
      const esperado = congelado
        ? { expectedFull: r.expected_full!, expectedEmpty: r.expected_empty! }
        : esperadoDe({
            loadedFull: r.loaded_full,
            reloadedFull: r.reloaded_full,
            deliveredFull: entregadas,
            loadedEmpty: r.loaded_empty,
            collectedEmpty: recolectadas,
          });
      return {
        itemId: r.item_id,
        gasCylinderId: r.gas_cylinder_id,
        gasCylinderType: r.type,
        loadedFull: r.loaded_full,
        reloadedFull: r.reloaded_full,
        loadedEmpty: r.loaded_empty,
        deliveredFull: entregadas,
        collectedEmpty: recolectadas,
        ...esperado,
        declaredReturnFull: r.declared_return_full,
        declaredReturnEmpty: r.declared_return_empty,
        differenceFull: congelado
          ? r.difference_full
          : r.declared_return_full === null
            ? null
            : diferenciaDe(r.declared_return_full, esperado.expectedFull),
        differenceEmpty: congelado
          ? r.difference_empty
          : r.declared_return_empty === null
            ? null
            : diferenciaDe(r.declared_return_empty, esperado.expectedEmpty),
        onTruckFull: enElCamion.get(`${r.gas_cylinder_id}|full`) ?? 0,
        onTruckEmpty: enElCamion.get(`${r.gas_cylinder_id}|empty`) ?? 0,
      };
    });

    // Lo que daría el cierre: el mismo plan que usa `CloseTruckLoadUseCase`,
    // sólo si ya se declaró la vuelta de todos los renglones.
    const declarada =
      abierta &&
      ubicacion !== undefined &&
      renglones.length > 0 &&
      renglones.every(
        (r) =>
          r.declared_return_full !== null && r.declared_return_empty !== null,
      );
    let hayDiferencia: boolean | null = null;
    let requiereVolverADeclarar = false;
    if (declarada && ubicacion && fila.returned_at) {
      // Mismo criterio que el cierre: una entrega del camión después de la
      // declaración la deja vieja y el cierre responde 409.
      requiereVolverADeclarar =
        entregasTardias(
          await this.onHand.movimientosDelCamion(
            this.dataSource.manager,
            ubicacion.location_id,
            fila.returned_at,
          ),
        ) > 0;
    }
    if (declarada && !requiereVolverADeclarar) {
      const { renglones: paraCierre } = renglonesDeCierre({
        items: renglones.map((r) => ({
          gasCylinderId: r.gas_cylinder_id,
          loadedFull: r.loaded_full,
          reloadedFull: r.reloaded_full,
          loadedEmpty: r.loaded_empty,
          declaredReturnFull: r.declared_return_full,
          declaredReturnEmpty: r.declared_return_empty,
        })),
        sinRenglon: [...conSaldo].filter(
          (g) => !renglones.some((r) => r.gas_cylinder_id === g),
        ),
        movidos: vivos,
        saldoDe: (g) => ({
          full: enElCamion.get(`${g}|full`) ?? 0,
          empty: enElCamion.get(`${g}|empty`) ?? 0,
          defective: enElCamion.get(`${g}|defective`) ?? 0,
        }),
      });
      hayDiferencia = planDeCierre(
        ubicacion.location_id,
        fila.origin_location_id,
        paraCierre,
      ).hayDiferencia;
    }

    const entregados = await this.orders.entregadosPorVehiculo({
      distributorId,
      deliveryId: fila.delivery_id,
      carId: fila.car_id,
      desde: fila.opened_at,
      hasta: abierta ? null : fila.closed_at,
    });
    const senas = await this.senasPagas(entregados.map((o) => o.orderId));
    const aCobrar = (o: { orderId: string; totalAmount: number }): number =>
      saldoACobrar(o.totalAmount, senas.get(o.orderId) ?? 0);
    const movimientos = await this.stockQuery.movimientos(distributorId, {
      referenceType: StockReferenceType.TRUCK_LOAD,
      referenceId: id,
      limit: 100,
      page: 1,
    });
    return {
      ...resumen(fila),
      items,
      hayDiferencia,
      requiereVolverADeclarar,
      differenceNote: fila.difference_note,
      cancelReason: fila.cancel_reason,
      notes: fila.notes,
      openedByUserId: fila.opened_by_user_id,
      orders: entregados.map(
        (o): TruckLoadOrderDto => ({
          orderId: o.orderId,
          totalAmount: o.totalAmount,
          remainingBalance: aCobrar(o),
          paymentMethod: o.paymentMethod,
          paymentStatus: o.paymentStatus,
          deliveredAt: o.deliveredAt,
        }),
      ),
      cash: this.efectivoDe(
        entregados.map((o) => ({ ...o, remainingBalance: aCobrar(o) })),
      ),
      movements: movimientos.data.reverse(),
      createdAt: fila.created_at,
    };
  }

  /**
   * Seña ya paga de cada pedido (0 si no hubo o no se pagó). Lee `order` de sólo
   * lectura, como el resto de este servicio: `entregadosPorVehiculo` (módulo
   * `order`) no la trae.
   */
  private async senasPagas(orderIds: string[]): Promise<Map<string, number>> {
    if (orderIds.length === 0) return new Map();
    const filas: Array<{ order_id: string; sena: string }> =
      await this.dataSource.query(
        `SELECT "order_id", "deposit_amount" AS sena FROM "order"
         WHERE "order_id" = ANY($1::uuid[]) AND "deposit_paid" = true`,
        [orderIds],
      );
    return new Map(filas.map((f) => [f.order_id, Number(f.sena)]));
  }

  /**
   * El efectivo de la jornada; informativo (la caja todavía no existe). En
   * efectivo se cuenta lo que el chofer cobra al entregar: el saldo
   * (`remainingBalance`: total menos la seña ya paga, igual que `OrderMapper`),
   * no el total.
   */
  private efectivoDe(
    pedidos: Array<{
      totalAmount: number;
      remainingBalance: number;
      paymentMethod: PaymentMethod;
      paymentStatus: PaymentStatus;
    }>,
  ): TruckLoadCashDto {
    const cash: TruckLoadCashDto = {
      deliveredOrders: pedidos.length,
      cashCollectedAmount: 0,
      cashCollectedCount: 0,
      unpaidAmount: 0,
      unpaidCount: 0,
      pendingConfirmationAmount: 0,
      pendingConfirmationCount: 0,
      nonCashAmount: 0,
    };
    for (const p of pedidos) {
      if (p.paymentMethod !== PaymentMethod.CASH) {
        // Cobrado = `paid`, cualquiera sea el medio: una transferencia o un
        // Mercado Pago pendiente todavía no cuenta.
        if (p.paymentStatus === PaymentStatus.PAID) {
          cash.nonCashAmount += p.totalAmount;
        }
      } else if (p.paymentStatus === PaymentStatus.PAID) {
        cash.cashCollectedAmount += p.remainingBalance;
        cash.cashCollectedCount += 1;
      } else if (
        p.paymentStatus === PaymentStatus.UNPAID ||
        p.paymentStatus === PaymentStatus.WRITTEN_OFF
      ) {
        cash.unpaidAmount += p.remainingBalance;
        cash.unpaidCount += 1;
      } else {
        cash.pendingConfirmationAmount += p.remainingBalance;
        cash.pendingConfirmationCount += 1;
      }
    }
    return cash;
  }

  /** La carga abierta del chofer (si tiene) y si la distribuidora exige tenerla. */
  async miCarga(
    distributorId: string,
    userId: string,
  ): Promise<MyTruckLoadDto> {
    const chofer = await this.deliveries.findOneByUserId(userId);
    const [abierta]: Array<{ load_id: string }> = await this.dataSource.query(
      `SELECT "load_id" FROM "truck_load"
       WHERE "distributor_id" = $1 AND "delivery_id" = $2 AND "status"::text = ANY($3::text[])`,
      [distributorId, chofer.deliveryId, ESTADOS_ABIERTOS],
    );
    const { requireOpenTruckLoad } = await this.settings.obtener(distributorId);
    return {
      load: abierta
        ? await this.detalle(abierta.load_id, distributorId, chofer.deliveryId)
        : null,
      requireOpenTruckLoad,
    };
  }

  /** El stock que hay hoy en un camión, por tipo de garrafa. */
  async stockDeCamion(
    distributorId: string,
    carId: string,
  ): Promise<TruckStockDto> {
    const [auto]: Array<{ car_patent: string | null }> =
      await this.dataSource.query(
        `SELECT "car_patent" FROM "car" WHERE "car_id" = $1 AND "distributor_id" = $2`,
        [carId, distributorId],
      );
    if (!auto) throw new NotFoundException(`Vehículo ${carId} no encontrado`);
    const filas: Array<{
      gas_cylinder_id: string;
      type: string;
      full: number;
      empty: number;
      defective: number;
    }> = await this.dataSource.query(
      `SELECT b."gas_cylinder_id", gc."type",
              COALESCE(SUM(b."quantity") FILTER (WHERE b."condition" = 'full'), 0)::int AS "full",
              COALESCE(SUM(b."quantity") FILTER (WHERE b."condition" = 'empty'), 0)::int AS "empty",
              COALESCE(SUM(b."quantity") FILTER (WHERE b."condition" = 'defective'), 0)::int AS defective
       FROM "stock_balance" b
       JOIN "stock_location" l ON l."location_id" = b."location_id"
       JOIN "gas_cylinder" gc ON gc."gas_cylinder_id" = b."gas_cylinder_id"
       WHERE l."car_id" = $1 AND l."distributor_id" = $2 AND b."quantity" > 0
       GROUP BY b."gas_cylinder_id", gc."type"
       ORDER BY gc."type"`,
      [carId, distributorId],
    );
    const [abierta]: Array<{ load_id: string }> = await this.dataSource.query(
      `SELECT "load_id" FROM "truck_load"
       WHERE "car_id" = $1 AND "status"::text = ANY($2::text[])`,
      [carId, ESTADOS_ABIERTOS],
    );
    return {
      carId,
      carPatent: auto.car_patent,
      openLoadId: abierta?.load_id ?? null,
      items: filas.map((f) => ({
        gasCylinderId: f.gas_cylinder_id,
        gasCylinderType: f.type,
        full: f.full,
        empty: f.empty,
        defective: f.defective,
      })),
    };
  }
}
