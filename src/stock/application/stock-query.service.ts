import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { rangoDeDiasArgentinos } from '../../common/utils/dias-argentina';
import { StockCondition, StockLocationKind } from '../domain/stock.enums';
import {
  QueryStockAdjustmentDto,
  QueryStockBalanceDto,
  QueryStockMovementDto,
} from '../dto/query-stock.dto';
import {
  ConditionTotalsDto,
  StockAdjustmentPageDto,
  StockAdjustmentResponseDto,
  StockBalanceDto,
  StockMovementDto,
  StockMovementPageDto,
  StockSummaryDto,
} from '../dto/stock-response.dto';

/** Nombre que se muestra de una ubicación (depósito o patente del vehículo). */
const NOMBRE_DE_UBICACION = `COALESCE(w."name", 'Vehículo ' || COALESCE(c."car_patent", l."car_id"::text))`;

const UBICACION_JOINS = `
  LEFT JOIN "warehouse" w ON w."warehouse_id" = l."warehouse_id"
  LEFT JOIN "car" c ON c."car_id" = l."car_id"`;

interface FilaDeSaldo {
  location_id: string;
  kind: StockLocationKind;
  warehouse_id: string | null;
  car_id: string | null;
  name: string;
  gas_cylinder_id: string;
  type: string;
  condition: StockCondition;
  quantity: number;
  updatedAt: Date;
}

interface FilaDeMovimiento {
  movement_id: string;
  batch_id: string;
  occurred_at: Date;
  gas_cylinder_id: string;
  type: string;
  quantity: number;
  from_location_id: string | null;
  from_name: string | null;
  from_kind: StockLocationKind | null;
  from_condition: StockCondition | null;
  to_location_id: string | null;
  to_name: string | null;
  to_kind: StockLocationKind | null;
  to_condition: StockCondition | null;
  reason: StockMovementDto['reason'];
  reference_type: StockMovementDto['referenceType'];
  reference_id: string | null;
  reversed_movement_id: string | null;
  notes: string | null;
  actor_name: string | null;
}

/** Lecturas del módulo: saldos, resumen, libro y ajustes. Sólo SELECT. */
@Injectable()
export class StockQueryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orders: OrderLookupService,
  ) {}

  async saldos(
    distributorId: string,
    query: QueryStockBalanceDto,
  ): Promise<StockBalanceDto[]> {
    const params: unknown[] = [distributorId];
    const where = [
      'b."distributor_id" = $1',
      '(w."warehouse_id" IS NULL OR w."deletedAt" IS NULL)',
    ];
    const filtro = (columna: string, valor: string | undefined) => {
      if (valor === undefined) return;
      params.push(valor);
      where.push(`${columna} = $${params.length}`);
    };
    filtro('b."location_id"', query.locationId);
    filtro('l."warehouse_id"', query.warehouseId);
    filtro('l."car_id"', query.carId);
    filtro('b."gas_cylinder_id"', query.gasCylinderId);
    if (!query.includeZero) where.push('b."quantity" > 0');

    const filas: FilaDeSaldo[] = await this.dataSource.query(
      `SELECT b."location_id", l."kind", l."warehouse_id", l."car_id",
              ${NOMBRE_DE_UBICACION} AS name,
              b."gas_cylinder_id", gc."type", b."condition", b."quantity", b."updatedAt"
       FROM "stock_balance" b
       JOIN "stock_location" l ON l."location_id" = b."location_id"
       JOIN "gas_cylinder" gc ON gc."gas_cylinder_id" = b."gas_cylinder_id"
       ${UBICACION_JOINS}
       WHERE ${where.join(' AND ')}
       ORDER BY l."kind", name, gc."type", b."condition"`,
      params,
    );
    return filas.map((f) => ({
      locationId: f.location_id,
      locationName: f.name,
      locationKind: f.kind,
      warehouseId: f.warehouse_id,
      carId: f.car_id,
      gasCylinderId: f.gas_cylinder_id,
      gasCylinderType: f.type,
      condition: f.condition,
      quantity: f.quantity,
      updatedAt: f.updatedAt,
    }));
  }

  /**
   * Galpón vs camiones, por tipo de garrafa: llenas, vacías y defectuosas en
   * depósitos y en vehículos, lo reservado por pedidos abiertos y el vendible.
   */
  async resumen(distributorId: string): Promise<StockSummaryDto[]> {
    const [garrafas, saldos, minimos, reservadas] = await Promise.all([
      this.dataSource.query<
        Array<{ gas_cylinder_id: string; type: string; stock: number }>
      >(
        `SELECT "gas_cylinder_id", "type", "stock" FROM "gas_cylinder"
         WHERE "distributor_id" = $1 AND ("isActive" = true OR "stock" > 0)
         ORDER BY "type"`,
        [distributorId],
      ),
      this.dataSource.query<
        Array<{
          gas_cylinder_id: string;
          kind: StockLocationKind;
          condition: StockCondition;
          total: string;
        }>
      >(
        `SELECT b."gas_cylinder_id", l."kind", b."condition", SUM(b."quantity") AS total
         FROM "stock_balance" b
         JOIN "stock_location" l ON l."location_id" = b."location_id"
         WHERE b."distributor_id" = $1
         GROUP BY b."gas_cylinder_id", l."kind", b."condition"`,
        [distributorId],
      ),
      this.dataSource.query<Array<{ gas_cylinder_id: string; total: string }>>(
        `SELECT t."gas_cylinder_id", SUM(t."min_full") AS total
         FROM "stock_threshold" t
         JOIN "warehouse" w ON w."warehouse_id" = t."warehouse_id" AND w."deletedAt" IS NULL
         WHERE t."distributor_id" = $1 AND t."min_full" > 0
         GROUP BY t."gas_cylinder_id"`,
        [distributorId],
      ),
      this.orders.reservedByCylinder(distributorId),
    ]);

    return garrafas.map((g) => {
      const vacio = (): ConditionTotalsDto => ({
        full: 0,
        empty: 0,
        defective: 0,
      });
      const warehouses = vacio();
      const vehicles = vacio();
      for (const s of saldos) {
        if (s.gas_cylinder_id !== g.gas_cylinder_id) continue;
        const destino =
          s.kind === StockLocationKind.WAREHOUSE ? warehouses : vehicles;
        destino[s.condition] += Number(s.total);
      }
      const minimo = minimos.find(
        (m) => m.gas_cylinder_id === g.gas_cylinder_id,
      );
      return {
        gasCylinderId: g.gas_cylinder_id,
        gasCylinderType: g.type,
        warehouses,
        vehicles,
        physicalFull: warehouses.full + vehicles.full,
        reserved: reservadas.get(g.gas_cylinder_id) ?? 0,
        sellable: g.stock,
        minimumFull: minimo ? Number(minimo.total) : null,
      };
    });
  }

  async movimientos(
    distributorId: string,
    query: QueryStockMovementDto,
  ): Promise<StockMovementPageDto> {
    const params: unknown[] = [distributorId];
    const where = ['m."distributor_id" = $1'];
    const agregar = (condicion: (n: number) => string, valor: unknown) => {
      params.push(valor);
      where.push(condicion(params.length));
    };
    if (query.gasCylinderId) {
      agregar((n) => `m."gas_cylinder_id" = $${n}`, query.gasCylinderId);
    }
    if (query.locationId) {
      agregar(
        (n) => `(m."from_location_id" = $${n} OR m."to_location_id" = $${n})`,
        query.locationId,
      );
    }
    if (query.reason) agregar((n) => `m."reason" = $${n}`, query.reason);
    if (query.referenceType) {
      agregar((n) => `m."reference_type" = $${n}`, query.referenceType);
    }
    if (query.batchId) agregar((n) => `m."batch_id" = $${n}`, query.batchId);

    if (query.from || query.to) {
      const desde = query.from ?? query.to!;
      const hasta = query.to ?? query.from!;
      const rango = rangoDeDiasArgentinos(desde, hasta);
      if (!rango) {
        throw new BadRequestException('Las fechas tienen que ser YYYY-MM-DD');
      }
      if (rango.desde >= rango.hasta) {
        throw new BadRequestException('"from" no puede ser posterior a "to"');
      }
      agregar((n) => `m."occurred_at" >= $${n}`, rango.desde);
      agregar((n) => `m."occurred_at" < $${n}`, rango.hasta);
    }

    const limit = query.limit ?? 10;
    const offset = ((query.page ?? 1) - 1) * limit;
    const [{ total }]: Array<{ total: string }> = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM "stock_movement" m WHERE ${where.join(' AND ')}`,
      params,
    );
    const filas = await this.seleccionarMovimientos(
      where.join(' AND '),
      params,
      `LIMIT ${limit} OFFSET ${offset}`,
    );
    return { data: filas, total: Number(total) };
  }

  /** Los movimientos de un lote, en el orden en que se asentaron. */
  async movimientosDelLote(
    distributorId: string,
    batchId: string,
  ): Promise<StockMovementDto[]> {
    return this.seleccionarMovimientos(
      'm."distributor_id" = $1 AND m."batch_id" = $2',
      [distributorId, batchId],
      '',
      // Los movimientos de un lote comparten instante: se ordenan por lo que se ve.
      'gc."type", m."reason", m."from_condition", m."to_condition", m."movement_id"',
    );
  }

  private async seleccionarMovimientos(
    where: string,
    params: unknown[],
    paginacion: string,
    orden = 'm."occurred_at" DESC, m."movement_id" DESC',
  ): Promise<StockMovementDto[]> {
    const filas: FilaDeMovimiento[] = await this.dataSource.query(
      `SELECT m."movement_id", m."batch_id", m."occurred_at", m."gas_cylinder_id", gc."type",
              m."quantity", m."from_location_id", m."from_condition", m."to_location_id", m."to_condition",
              m."reason", m."reference_type", m."reference_id", m."reversed_movement_id", m."notes",
              (SELECT ${NOMBRE_DE_UBICACION} FROM "stock_location" l ${UBICACION_JOINS} WHERE l."location_id" = m."from_location_id") AS from_name,
              (SELECT l."kind" FROM "stock_location" l WHERE l."location_id" = m."from_location_id") AS from_kind,
              (SELECT ${NOMBRE_DE_UBICACION} FROM "stock_location" l ${UBICACION_JOINS} WHERE l."location_id" = m."to_location_id") AS to_name,
              (SELECT l."kind" FROM "stock_location" l WHERE l."location_id" = m."to_location_id") AS to_kind,
              u."full_name" AS actor_name
       FROM "stock_movement" m
       JOIN "gas_cylinder" gc ON gc."gas_cylinder_id" = m."gas_cylinder_id"
       LEFT JOIN "user" u ON u."user_id" = m."actor_user_id"
       WHERE ${where}
       ORDER BY ${orden}
       ${paginacion}`,
      params,
    );
    return filas.map((f) => ({
      movementId: f.movement_id,
      batchId: f.batch_id,
      occurredAt: f.occurred_at,
      gasCylinderId: f.gas_cylinder_id,
      gasCylinderType: f.type,
      quantity: f.quantity,
      from:
        f.from_location_id && f.from_name && f.from_kind
          ? {
              locationId: f.from_location_id,
              name: f.from_name,
              kind: f.from_kind,
            }
          : null,
      fromCondition: f.from_condition,
      to:
        f.to_location_id && f.to_name && f.to_kind
          ? { locationId: f.to_location_id, name: f.to_name, kind: f.to_kind }
          : null,
      toCondition: f.to_condition,
      reason: f.reason,
      referenceType: f.reference_type,
      referenceId: f.reference_id,
      reversedMovementId: f.reversed_movement_id,
      notes: f.notes,
      actorName: f.actor_name,
    }));
  }

  async ajustes(
    distributorId: string,
    query: QueryStockAdjustmentDto,
  ): Promise<StockAdjustmentPageDto> {
    const params: unknown[] = [distributorId];
    const where = ['a."distributor_id" = $1'];
    if (query.reason) {
      params.push(query.reason);
      where.push(`a."reason" = $${params.length}`);
    }
    if (query.from || query.to) {
      const rango = rangoDeDiasArgentinos(
        query.from ?? query.to!,
        query.to ?? query.from!,
      );
      if (!rango) {
        throw new BadRequestException('Las fechas tienen que ser YYYY-MM-DD');
      }
      if (rango.desde >= rango.hasta) {
        throw new BadRequestException('"from" no puede ser posterior a "to"');
      }
      params.push(rango.desde, rango.hasta);
      where.push(
        `a."createdAt" >= $${params.length - 1} AND a."createdAt" < $${params.length}`,
      );
    }
    const limit = query.limit ?? 10;
    const offset = ((query.page ?? 1) - 1) * limit;
    const [{ total }]: Array<{ total: string }> = await this.dataSource.query(
      `SELECT COUNT(*) AS total FROM "stock_adjustment" a WHERE ${where.join(' AND ')}`,
      params,
    );
    const ids: Array<{ adjustment_id: string }> = await this.dataSource.query(
      `SELECT a."adjustment_id" FROM "stock_adjustment" a
       WHERE ${where.join(' AND ')}
       ORDER BY a."number" DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    const data = await this.cargarAjustes(
      ids.map((i) => i.adjustment_id),
      distributorId,
    );
    return { data, total: Number(total) };
  }

  async ajuste(
    adjustmentId: string,
    distributorId: string,
  ): Promise<StockAdjustmentResponseDto> {
    const [ajuste] = await this.cargarAjustes([adjustmentId], distributorId);
    if (!ajuste) {
      throw new NotFoundException(`Ajuste ${adjustmentId} no encontrado`);
    }
    return ajuste;
  }

  /** Cabeceras e ítems de varios ajustes en DOS consultas (no una por ajuste). */
  private async cargarAjustes(
    ids: string[],
    distributorId: string,
  ): Promise<StockAdjustmentResponseDto[]> {
    if (ids.length === 0) return [];
    const cabeceras: Array<{
      adjustment_id: string;
      number: number;
      location_id: string;
      location_name: string;
      location_kind: StockLocationKind;
      reason: StockAdjustmentResponseDto['reason'];
      notes: string;
      batch_id: string;
      created_by_name: string | null;
      createdAt: Date;
    }> = await this.dataSource.query(
      `SELECT a."adjustment_id", a."number", a."location_id", a."reason", a."notes", a."batch_id", a."createdAt",
              ${NOMBRE_DE_UBICACION} AS location_name, l."kind" AS location_kind,
              u."full_name" AS created_by_name
       FROM "stock_adjustment" a
       JOIN "stock_location" l ON l."location_id" = a."location_id"
       ${UBICACION_JOINS}
       LEFT JOIN "user" u ON u."user_id" = a."created_by_user_id"
       WHERE a."adjustment_id" = ANY($1::uuid[]) AND a."distributor_id" = $2
       ORDER BY a."number" DESC`,
      [ids, distributorId],
    );
    if (cabeceras.length === 0) return [];
    const items: Array<{
      adjustment_id: string;
      gas_cylinder_id: string;
      type: string;
      condition: StockCondition;
      quantity_delta: number;
    }> = await this.dataSource.query(
      `SELECT i."adjustment_id", i."gas_cylinder_id", gc."type", i."condition", i."quantity_delta"
       FROM "stock_adjustment_item" i
       JOIN "gas_cylinder" gc ON gc."gas_cylinder_id" = i."gas_cylinder_id"
       WHERE i."adjustment_id" = ANY($1::uuid[])
       ORDER BY gc."type", i."condition"`,
      [cabeceras.map((c) => c.adjustment_id)],
    );
    return cabeceras.map((c) => ({
      adjustmentId: c.adjustment_id,
      number: c.number,
      location: {
        locationId: c.location_id,
        name: c.location_name,
        kind: c.location_kind,
      },
      reason: c.reason,
      notes: c.notes,
      batchId: c.batch_id,
      createdByName: c.created_by_name,
      createdAt: c.createdAt,
      items: items
        .filter((i) => i.adjustment_id === c.adjustment_id)
        .map((i) => ({
          gasCylinderId: i.gas_cylinder_id,
          gasCylinderType: i.type,
          condition: i.condition,
          quantityDelta: i.quantity_delta,
        })),
    }));
  }
}
