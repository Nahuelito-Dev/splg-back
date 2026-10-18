import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import {
  diaArgentino,
  rangoDeDiasArgentinos,
} from '../../common/utils/dias-argentina';
import { aCentavos, dec } from '../../common/utils/dinero';
import {
  AgingBucket,
  CustomerEntryType,
} from '../domain/customer-account.enums';
import {
  creditoDisponible,
  diasEntre,
  rangoDeAntiguedad,
  signoDelAsiento,
} from '../domain/customer-account-rules';
import {
  CuentaInvalidaError,
  CuentaNoEncontradaError,
} from '../domain/errors/customer-account.errors';
import {
  AgingBucketsDto,
  AgingReportDto,
  CustomerAccountDetailDto,
  CustomerAccountPageDto,
  CustomerAccountResponseDto,
  CustomerEntryResponseDto,
  CustomerStatementDto,
  QueryCustomerAccountDto,
  QueryCustomerEntryDto,
} from '../dto/customer-account.dto';

interface FilaDeCuenta {
  account_id: string;
  customer_user_id: string;
  customer_name: string | null;
  customer_email: string | null;
  business_name: string;
  tax_id: string | null;
  tax_condition: CustomerAccountResponseDto['taxCondition'];
  credit_limit: string;
  payment_terms_days: number;
  status: CustomerAccountResponseDto['status'];
  balance: string;
  created_at: Date;
  updated_at: Date;
}

interface CargoAbierto {
  account_id: string;
  occurred_at: Date;
  due_date: string | null;
  abierto: string;
}

const COLUMNAS_DE_CUENTA = `
  a."account_id", a."customer_user_id", u."full_name" AS customer_name, u."email" AS customer_email,
  a."business_name", a."tax_id", a."tax_condition", a."credit_limit", a."payment_terms_days",
  a."status", a."balance", a."createdAt" AS created_at, a."updatedAt" AS updated_at`;

const SQL_CARGOS_ABIERTOS = `
  SELECT e."account_id", e."occurred_at", e."due_date",
         (e."amount" - COALESCE(al.aplicado, 0))::text AS abierto
  FROM "customer_account_entry" e
  LEFT JOIN LATERAL (
    SELECT SUM(a."amount") AS aplicado FROM "customer_account_allocation" a
    WHERE a."debit_entry_id" = e."entry_id") al ON true
  WHERE e."distributor_id" = $1 AND e."type" IN ('sale_charge', 'debit_note')
    AND e."amount" > COALESCE(al.aplicado, 0)`;

/** Lecturas de las cuentas corrientes: listado, ficha, estado de cuenta y antigüedad. */
@Injectable()
export class CustomerAccountQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findAll(
    distributorId: string,
    query: QueryCustomerAccountDto,
  ): Promise<CustomerAccountPageDto> {
    const hoy = diaArgentino();
    const limit = query.limit ?? 20;
    const condiciones = [`a."distributor_id" = $1`, `a."deletedAt" IS NULL`];
    const params: unknown[] = [distributorId];
    if (query.status) {
      params.push(query.status);
      condiciones.push(`a."status" = $${params.length}`);
    }
    const q = (query.q ?? query.term)?.trim();
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      condiciones.push(
        `(a."business_name" ILIKE $${i} OR a."tax_id" ILIKE $${i} OR u."full_name" ILIKE $${i} OR u."email" ILIKE $${i})`,
      );
    }
    if (query.overdue) {
      params.push(hoy);
      condiciones.push(`EXISTS (
        SELECT 1 FROM "customer_account_entry" e
        WHERE e."account_id" = a."account_id" AND e."type" IN ('sale_charge', 'debit_note')
          AND e."due_date" < $${params.length}
          AND e."amount" > COALESCE((SELECT SUM(al."amount") FROM "customer_account_allocation" al
                                     WHERE al."debit_entry_id" = e."entry_id"), 0))`);
    }
    const donde = condiciones.join(' AND ');
    const [{ total }]: Array<{ total: number }> = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM "customer_account" a
       JOIN "user" u ON u."user_id" = a."customer_user_id" WHERE ${donde}`,
      params,
    );
    const filas: FilaDeCuenta[] = await this.dataSource.query(
      `SELECT ${COLUMNAS_DE_CUENTA} FROM "customer_account" a
       JOIN "user" u ON u."user_id" = a."customer_user_id"
       WHERE ${donde} ORDER BY a."business_name" ASC
       LIMIT ${limit} OFFSET ${((query.page ?? 1) - 1) * limit}`,
      params,
    );
    return { data: await this.armar(distributorId, filas), total };
  }

  async findOne(
    id: string,
    distributorId: string,
  ): Promise<CustomerAccountDetailDto> {
    const [fila]: FilaDeCuenta[] = await this.dataSource.query(
      `SELECT ${COLUMNAS_DE_CUENTA} FROM "customer_account" a
       JOIN "user" u ON u."user_id" = a."customer_user_id"
       WHERE a."account_id" = $1 AND a."distributor_id" = $2 AND a."deletedAt" IS NULL`,
      [id, distributorId],
    );
    if (!fila) throw new CuentaNoEncontradaError(id);
    const [cuenta] = await this.armar(distributorId, [fila]);
    const cargos = await this.cargosAbiertos(distributorId, id);
    return Object.assign(new CustomerAccountDetailDto(), cuenta, {
      aging: this.bucketsDe(cargos),
    });
  }

  /** Estado de cuenta con el saldo corrido después de cada asiento. */
  async entries(
    id: string,
    distributorId: string,
    query: QueryCustomerEntryDto,
  ): Promise<CustomerStatementDto> {
    const existe: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM "customer_account" WHERE "account_id" = $1 AND "distributor_id" = $2 AND "deletedAt" IS NULL`,
      [id, distributorId],
    );
    if (existe.length === 0) throw new CuentaNoEncontradaError(id);
    if (query.from && query.to && query.from > query.to) {
      throw new CuentaInvalidaError(
        'La fecha inicial no puede ser posterior a la final',
      );
    }
    let desde: Date | null = null;
    let hasta: Date | null = null;
    if (query.from || query.to) {
      const rango = rangoDeDiasArgentinos(
        query.from ?? query.to ?? '',
        query.to ?? query.from ?? '',
      );
      if (!rango) throw new CuentaInvalidaError('El período no es válido');
      desde = query.from ? rango.desde : null;
      hasta = query.to ? rango.hasta : null;
    }
    const limit = query.limit ?? 50;
    const filas: Array<{
      entry_id: string;
      type: CustomerEntryType;
      amount: string;
      balance_after: string;
      order_id: string | null;
      due_date: string | null;
      payment_method: string | null;
      cash_movement_id: string | null;
      collected_by_delivery_id: string | null;
      description: string | null;
      occurred_at: Date;
      created_by_user_id: string | null;
      pendiente: string;
      total: number;
    }> = await this.dataSource.query(
      `WITH corrido AS (
         SELECT e.*,
                SUM(CASE WHEN e."type" IN ('sale_charge', 'debit_note') THEN e."amount" ELSE -e."amount" END)
                  OVER (ORDER BY e."occurred_at", e."createdAt", e."entry_id") AS balance_after
         FROM "customer_account_entry" e WHERE e."account_id" = $1
       ), periodo AS (
         SELECT c.*, COUNT(*) OVER () AS total FROM corrido c
         WHERE ($2::timestamptz IS NULL OR c."occurred_at" >= $2)
           AND ($3::timestamptz IS NULL OR c."occurred_at" < $3)
       )
       SELECT p."entry_id", p."type", p."amount"::text, p."balance_after"::text, p."order_id", p."due_date"::text AS due_date,
              p."payment_method", p."cash_movement_id", p."collected_by_delivery_id", p."description",
              p."occurred_at", p."created_by_user_id", p."total"::int,
              CASE WHEN p."type" IN ('sale_charge', 'debit_note')
                   THEN (p."amount" - COALESCE((SELECT SUM(a."amount") FROM "customer_account_allocation" a
                                                WHERE a."debit_entry_id" = p."entry_id"), 0))::text
                   ELSE '0' END AS pendiente
       FROM periodo p ORDER BY p."occurred_at", p."createdAt", p."entry_id"
       LIMIT ${limit} OFFSET ${((query.page ?? 1) - 1) * limit}`,
      [id, desde, hasta],
    );
    const [{ apertura, cierre }]: Array<{ apertura: string; cierre: string }> =
      await this.dataSource.query(
        `SELECT COALESCE(SUM(CASE WHEN "type" IN ('sale_charge', 'debit_note') THEN "amount" ELSE -"amount" END)
                  FILTER (WHERE $2::timestamptz IS NOT NULL AND "occurred_at" < $2), 0)::text AS apertura,
                COALESCE(SUM(CASE WHEN "type" IN ('sale_charge', 'debit_note') THEN "amount" ELSE -"amount" END)
                  FILTER (WHERE $3::timestamptz IS NULL OR "occurred_at" < $3), 0)::text AS cierre
         FROM "customer_account_entry" WHERE "account_id" = $1`,
        [id, desde, hasta],
      );
    return {
      openingBalance: aCentavos(dec(apertura)),
      closingBalance: aCentavos(dec(cierre)),
      total: filas[0]?.total ?? 0,
      data: filas.map((f) => {
        const dto = new CustomerEntryResponseDto();
        dto.entryId = f.entry_id;
        dto.type = f.type;
        dto.amount = Number(f.amount);
        dto.signedAmount = Number(f.amount) * signoDelAsiento(f.type);
        dto.balanceAfter = Number(f.balance_after);
        dto.orderId = f.order_id;
        dto.dueDate = f.due_date;
        dto.paymentMethod = f.payment_method;
        dto.cashMovementId = f.cash_movement_id;
        dto.collectedByDeliveryId = f.collected_by_delivery_id;
        dto.description = f.description;
        dto.pendingAmount = Number(f.pendiente);
        dto.occurredAt = f.occurred_at;
        dto.createdByUserId = f.created_by_user_id;
        return dto;
      }),
    };
  }

  /** Antigüedad de la deuda de toda la distribuidora, por cuenta y en total. */
  async aging(distributorId: string): Promise<AgingReportDto> {
    const cargos = await this.cargosAbiertos(distributorId);
    const nombres: Array<{ account_id: string; business_name: string }> =
      await this.dataSource.query(
        `SELECT "account_id", "business_name" FROM "customer_account"
         WHERE "distributor_id" = $1 AND "deletedAt" IS NULL`,
        [distributorId],
      );
    const porCuenta = new Map<string, CargoAbierto[]>();
    for (const c of cargos) {
      porCuenta.set(c.account_id, [...(porCuenta.get(c.account_id) ?? []), c]);
    }
    const accounts = [...porCuenta.entries()]
      .map(([accountId, lista]) => ({
        accountId,
        businessName:
          nombres.find((n) => n.account_id === accountId)?.business_name ?? '',
        ...this.bucketsDe(lista),
      }))
      .sort((a, b) => b.total - a.total);
    return { totals: this.bucketsDe(cargos), accounts };
  }

  private async cargosAbiertos(
    distributorId: string,
    accountId?: string,
  ): Promise<CargoAbierto[]> {
    return this.dataSource.query(
      accountId
        ? `${SQL_CARGOS_ABIERTOS} AND e."account_id" = $2`
        : SQL_CARGOS_ABIERTOS,
      accountId ? [distributorId, accountId] : [distributorId],
    );
  }

  /** Reparte lo que se debe por antigüedad del comprobante (días hasta hoy). */
  private bucketsDe(cargos: CargoAbierto[]): AgingBucketsDto {
    const hoy = diaArgentino();
    const suma: Record<AgingBucket, Decimal> = {
      [AgingBucket.D0_30]: new Decimal(0),
      [AgingBucket.D31_60]: new Decimal(0),
      [AgingBucket.D61_90]: new Decimal(0),
      [AgingBucket.D90_PLUS]: new Decimal(0),
    };
    for (const c of cargos) {
      const dias = Math.max(
        0,
        diasEntre(diaArgentino(new Date(c.occurred_at)), hoy),
      );
      const rango = rangoDeAntiguedad(dias);
      suma[rango] = suma[rango].plus(c.abierto);
    }
    const dto = new AgingBucketsDto();
    dto.upTo30Days = aCentavos(suma[AgingBucket.D0_30]);
    dto.from31To60Days = aCentavos(suma[AgingBucket.D31_60]);
    dto.from61To90Days = aCentavos(suma[AgingBucket.D61_90]);
    dto.over90Days = aCentavos(suma[AgingBucket.D90_PLUS]);
    dto.total = aCentavos(
      Object.values(suma).reduce((a, b) => a.plus(b), new Decimal(0)),
    );
    return dto;
  }

  /** Completa cada cuenta con pedidos abiertos, crédito disponible y deuda vencida. */
  private async armar(
    distributorId: string,
    filas: FilaDeCuenta[],
  ): Promise<CustomerAccountResponseDto[]> {
    if (filas.length === 0) return [];
    const hoy = diaArgentino();
    const abiertos: Array<{ customer_id: string; total: string }> =
      await this.dataSource.query(
        `SELECT o."customer_id", COALESCE(SUM(o."totalAmount"), 0)::text AS total
         FROM "order" o
         WHERE o."distributor_id" = $1 AND o."customer_id" = ANY($2::uuid[])
           AND o."paymentMethod" = 'account' AND o."status" <> 'cancelled'
           AND NOT EXISTS (SELECT 1 FROM "customer_account_entry" e
                           WHERE e."order_id" = o."order_id" AND e."type" = 'sale_charge')
         GROUP BY o."customer_id"`,
        [distributorId, filas.map((f) => f.customer_user_id)],
      );
    const vencidos: Array<{ account_id: string; total: string }> =
      await this.dataSource.query(
        `${`SELECT x."account_id", COALESCE(SUM(x.abierto::numeric), 0)::text AS total FROM (${SQL_CARGOS_ABIERTOS} AND e."due_date" < $2 AND e."account_id" = ANY($3::uuid[])) x GROUP BY x."account_id"`}`,
        [distributorId, hoy, filas.map((f) => f.account_id)],
      );
    return filas.map((f) => {
      const pendientes = dec(
        abiertos.find((a) => a.customer_id === f.customer_user_id)?.total,
      );
      const dto = new CustomerAccountResponseDto();
      dto.accountId = f.account_id;
      dto.customerUserId = f.customer_user_id;
      dto.customerName = f.customer_name ?? '';
      dto.customerEmail = f.customer_email;
      dto.businessName = f.business_name;
      dto.taxId = f.tax_id;
      dto.taxCondition = f.tax_condition;
      dto.creditLimit = Number(f.credit_limit);
      dto.paymentTermsDays = f.payment_terms_days;
      dto.status = f.status;
      dto.balance = Number(f.balance);
      dto.pendingOrdersAmount = aCentavos(pendientes);
      dto.availableCredit = aCentavos(
        creditoDisponible(f.credit_limit, f.balance, pendientes),
      );
      dto.overdueAmount = aCentavos(
        dec(vencidos.find((v) => v.account_id === f.account_id)?.total),
      );
      dto.createdAt = f.created_at;
      dto.updatedAt = f.updated_at;
      return dto;
    });
  }
}
