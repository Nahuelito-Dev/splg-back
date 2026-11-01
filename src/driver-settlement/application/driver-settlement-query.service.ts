import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { deliveryIdDelUsuario } from '../../common/tenancy/chofer-empleado';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { aCentavos, dec } from '../../common/utils/dinero';
import {
  cuentasDeRendicion,
  exigirEstado,
} from '../domain/driver-settlement-rules';
import { DriverSettlementStatus } from '../domain/driver-settlement.enums';
import {
  ChoferNoEncontradoError,
  RendicionNoEncontradaError,
} from '../domain/errors/driver-settlement.errors';
import {
  DriverSettlementDetailDto,
  DriverSettlementPageDto,
  DriverSettlementResponseDto,
  PreviewDriverSettlementDto,
  QueryDriverSettlementDto,
  SettlementPreviewDto,
} from '../dto/driver-settlement.dto';
import { DriverSettlement } from '../entities/driver-settlement.entity';
import { exigirRendicionDelUsuario } from './settlement-propietario';
import { clientesDeEntrega } from './settlement-clientes';
import { pedidosSinRendir, sumaACobrar } from './settlement-orders';

/** Lecturas de las rendiciones: listado, ficha y tablero (CU-232, 233). */
@Injectable()
export class DriverSettlementQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findAll(
    distributorId: string,
    query: QueryDriverSettlementDto,
  ): Promise<DriverSettlementPageDto> {
    const qb = this.dataSource.manager
      .createQueryBuilder(DriverSettlement, 's')
      .where('s.distributorId = :distributorId', { distributorId });
    if (query.date) qb.andWhere('s.businessDate = :date', { date: query.date });
    if (query.status)
      qb.andWhere('s.status = :status', { status: query.status });
    if (query.deliveryId) {
      qb.andWhere('s.deliveryId = :deliveryId', {
        deliveryId: query.deliveryId,
      });
    }
    const limit = query.limit ?? 20;
    const [filas, total] = await qb
      .orderBy('s.businessDate', 'DESC')
      .addOrderBy('s.number', 'DESC')
      .skip(((query.page ?? 1) - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const nombres = await this.nombresDeChoferes(filas);
    const data: DriverSettlementResponseDto[] = [];
    for (const s of filas) {
      // Una abierta muestra lo esperado en vivo, no el valor de cuando se abrió.
      const esperado =
        s.status === DriverSettlementStatus.OPEN
          ? (await this.esperadoEnVivo(this.dataSource.manager, s)).expected
          : dec(s.expectedCash);
      data.push(this.resumen(s, nombres.get(s.deliveryId) ?? '', esperado));
    }
    return { data, total };
  }

  async detalle(
    id: string,
    distributorId: string,
    soloDelUsuario?: string,
  ): Promise<DriverSettlementDetailDto> {
    const s = await this.dataSource.manager.findOne(DriverSettlement, {
      where: { settlementId: id, distributorId },
    });
    if (!s) throw new RendicionNoEncontradaError(id);
    if (soloDelUsuario) {
      await exigirRendicionDelUsuario(
        this.dataSource.manager,
        s,
        soloDelUsuario,
      );
    }
    return this.armarDetalle(s);
  }

  /**
   * Vista previa de lo que se guardaría al presentar (CU-232): la misma cuenta
   * que `presentar`, sobre lo esperado en vivo y sin escribir nada. Sólo una
   * rendición abierta se puede presentar, y por eso previsualizar.
   */
  async vistaPrevia(
    id: string,
    dto: PreviewDriverSettlementDto,
    distributorId: string,
    soloDelUsuario?: string,
  ): Promise<SettlementPreviewDto> {
    const s = await this.dataSource.manager.findOne(DriverSettlement, {
      where: { settlementId: id, distributorId },
    });
    if (!s) throw new RendicionNoEncontradaError(id);
    if (soloDelUsuario) {
      await exigirRendicionDelUsuario(
        this.dataSource.manager,
        s,
        soloDelUsuario,
      );
    }
    exigirEstado(s.status, 'submit');
    const { expected } = await this.esperadoEnVivo(this.dataSource.manager, s);
    const cuentas = cuentasDeRendicion(
      dto.declaredCash,
      (dto.expenses ?? []).map((g) => g.amount),
      expected,
    );
    const preview = new SettlementPreviewDto();
    preview.expectedCash = aCentavos(expected);
    preview.declaredCash = aCentavos(dto.declaredCash);
    preview.driverExpenses = aCentavos(cuentas.gastos);
    preview.difference = aCentavos(cuentas.diferencia);
    return preview;
  }

  /** La rendición del chofer en sesión ese día (por defecto hoy). */
  async miRendicionId(
    userId: string,
    distributorId: string,
    date?: string,
  ): Promise<{ deliveryId: string; businessDate: string }> {
    const deliveryId = await deliveryIdDelUsuario(
      this.dataSource.manager,
      userId,
      distributorId,
    );
    if (!deliveryId) throw new ChoferNoEncontradoError(userId);
    return { deliveryId, businessDate: date ?? diaArgentino() };
  }

  /** Conteo del día para el tablero financiero (CU-245). */
  async resumenDelDia(
    distributorId: string,
    date: string,
  ): Promise<{
    open: number;
    submitted: number;
    approved: number;
    overdue: number;
    pendingCash: number;
  }> {
    const [fila]: Array<{
      open: number;
      submitted: number;
      approved: number;
      overdue: number;
      pendiente: string;
    }> = await this.dataSource.query(
      `SELECT COUNT(*) FILTER (WHERE "business_date" = $2 AND "status" = 'open')::int AS open,
              COUNT(*) FILTER (WHERE "business_date" = $2 AND "status" = 'submitted')::int AS submitted,
              COUNT(*) FILTER (WHERE "business_date" = $2 AND "status" = 'approved')::int AS approved,
              COUNT(*) FILTER (WHERE "business_date" < $3 AND "status" IN ('open', 'submitted'))::int AS overdue,
              COALESCE(SUM("declared_cash") FILTER (WHERE "status" = 'submitted'), 0)::text AS pendiente
       FROM "driver_settlement" WHERE "distributor_id" = $1`,
      [distributorId, date, diaArgentino()],
    );
    return {
      open: fila.open,
      submitted: fila.submitted,
      approved: fila.approved,
      overdue: fila.overdue,
      pendingCash: aCentavos(dec(fila.pendiente)),
    };
  }

  /** Lo esperado: pedidos sin rendir (si está abierta) o los ya rendidos, más los cobros de la calle. */
  async esperadoEnVivo(
    manager: EntityManager,
    s: DriverSettlement,
  ): Promise<{
    pedidos: Awaited<ReturnType<typeof pedidosSinRendir>>;
    cashFromOrders: ReturnType<typeof dec>;
    cashFromCollections: ReturnType<typeof dec>;
    expected: ReturnType<typeof dec>;
  }> {
    const pedidos =
      s.status === DriverSettlementStatus.OPEN
        ? await pedidosSinRendir(manager, {
            distributorId: s.distributorId,
            deliveryId: s.deliveryId,
            businessDate: s.businessDate,
          })
        : await this.pedidosRendidos(manager, s.settlementId);
    const [cobros]: Array<{ total: string }> = await manager.query(
      `SELECT COALESCE(SUM("amount"), 0)::text AS total
       FROM "driver_settlement_collection" WHERE "settlement_id" = $1`,
      [s.settlementId],
    );
    const cashFromOrders = sumaACobrar(pedidos);
    const cashFromCollections = dec(cobros.total);
    return {
      pedidos,
      cashFromOrders,
      cashFromCollections,
      expected: cashFromOrders.plus(cashFromCollections),
    };
  }

  private async armarDetalle(
    s: DriverSettlement,
  ): Promise<DriverSettlementDetailDto> {
    const m = this.dataSource.manager;
    const vivo = await this.esperadoEnVivo(m, s);
    const nombres = await this.nombresDeChoferes([s]);
    const esperado =
      s.status === DriverSettlementStatus.OPEN
        ? vivo.expected
        : dec(s.expectedCash);
    const cobros: Array<{
      entry_id: string;
      account_id: string;
      business_name: string;
      amount: string;
      created_at: Date;
    }> = await m.query(
      `SELECT c."entry_id", e."account_id", a."business_name", c."amount"::text, c."createdAt" AS created_at
       FROM "driver_settlement_collection" c
       JOIN "customer_account_entry" e ON e."entry_id" = c."entry_id"
       JOIN "customer_account" a ON a."account_id" = e."account_id"
       WHERE c."settlement_id" = $1 ORDER BY c."createdAt"`,
      [s.settlementId],
    );
    const gastos: Array<{
      expense_id: string;
      category_id: string;
      category_name: string;
      amount: string;
      description: string | null;
    }> = await m.query(
      `SELECT x."expense_id", x."category_id", c."name" AS category_name, x."amount"::text, x."description"
       FROM "driver_settlement_expense" x
       JOIN "cash_category" c ON c."category_id" = x."category_id"
       WHERE x."settlement_id" = $1 ORDER BY c."name"`,
      [s.settlementId],
    );
    let truckLoadStatus: string | null = null;
    if (s.truckLoadId) {
      const [carga]: Array<{ status: string }> = await m.query(
        `SELECT "status" FROM "truck_load" WHERE "load_id" = $1`,
        [s.truckLoadId],
      );
      truckLoadStatus = carga?.status ?? null;
    }
    const dto = Object.assign(
      new DriverSettlementDetailDto(),
      this.resumen(s, nombres.get(s.deliveryId) ?? '', esperado),
    );
    dto.cashFromOrders = aCentavos(vivo.cashFromOrders);
    dto.cashFromCollections = aCentavos(vivo.cashFromCollections);
    dto.truckLoadStatus = truckLoadStatus;
    const clientes = await clientesDeEntrega(
      m,
      s.distributorId,
      vivo.pedidos.map((p) => p.orderId),
    );
    dto.orders = vivo.pedidos.map((p) => ({
      orderId: p.orderId,
      customerName: clientes.get(p.orderId)?.customerName ?? null,
      deliveryAddress: clientes.get(p.orderId)?.deliveryAddress ?? null,
      totalAmount: p.totalAmount,
      amountToCollect: p.amountToCollect,
      paymentStatus: p.paymentStatus,
      deliveredAt: p.deliveredAt,
    }));
    dto.collections = cobros.map((c) => ({
      entryId: c.entry_id,
      accountId: c.account_id,
      businessName: c.business_name,
      amount: Number(c.amount),
      collectedAt: c.created_at,
    }));
    dto.expenses = gastos.map((g) => ({
      expenseId: g.expense_id,
      categoryId: g.category_id,
      categoryName: g.category_name,
      amount: Number(g.amount),
      description: g.description,
    }));
    return dto;
  }

  private async pedidosRendidos(
    manager: EntityManager,
    settlementId: string,
  ): Promise<Awaited<ReturnType<typeof pedidosSinRendir>>> {
    const filas: Array<{
      order_id: string;
      total: string;
      amount: string;
      payment_status: string;
      delivered_at: Date;
    }> = await manager.query(
      `SELECT d."order_id", o."totalAmount"::text AS total, d."amount"::text,
              o."paymentStatus" AS payment_status, o."deliveredAt" AS delivered_at
       FROM "driver_settlement_order" d JOIN "order" o ON o."order_id" = d."order_id"
       WHERE d."settlement_id" = $1 ORDER BY o."deliveredAt", d."order_id"`,
      [settlementId],
    );
    return filas.map((f) => ({
      orderId: f.order_id,
      totalAmount: Number(f.total),
      amountToCollect: Number(f.amount),
      paymentStatus: f.payment_status,
      deliveredAt: f.delivered_at,
    }));
  }

  private resumen(
    s: DriverSettlement,
    driverName: string,
    esperado: ReturnType<typeof dec>,
  ): DriverSettlementResponseDto {
    const dto = new DriverSettlementResponseDto();
    dto.settlementId = s.settlementId;
    dto.number = s.number;
    dto.deliveryId = s.deliveryId;
    dto.driverName = driverName;
    dto.businessDate = s.businessDate;
    dto.status = s.status;
    dto.expectedCash = aCentavos(esperado);
    dto.declaredCash = s.declaredCash;
    dto.driverExpenses = s.driverExpenses;
    dto.difference = s.difference;
    dto.differenceResolution = s.differenceResolution;
    dto.truckLoadId = s.truckLoadId;
    dto.destinationCashBoxId = s.destinationCashBoxId;
    dto.cashMovementId = s.cashMovementId;
    dto.submittedAt = s.submittedAt;
    dto.approvedAt = s.approvedAt;
    dto.notes = s.notes;
    dto.createdAt = s.createdAt;
    return dto;
  }

  private async nombresDeChoferes(
    rendiciones: DriverSettlement[],
  ): Promise<Map<string, string>> {
    if (rendiciones.length === 0) return new Map();
    const filas: Array<{ delivery_id: string; nombre: string | null }> =
      await this.dataSource.query(
        `SELECT d."delivery_id", u."full_name" AS nombre FROM "delivery" d
         JOIN "user" u ON u."user_id" = d."user_id"
         WHERE d."delivery_id" = ANY($1::uuid[])`,
        [[...new Set(rendiciones.map((r) => r.deliveryId))]],
      );
    return new Map(filas.map((f) => [f.delivery_id, f.nombre ?? '']));
  }
}
