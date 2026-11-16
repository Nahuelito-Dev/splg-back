import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  diasEntre,
  lunesDeLaSemana,
  primerDiaDelMes,
  primerDiaDelMesSiguiente,
  rangoDeDiasArgentinos,
  sumarDias,
  ZONA_ARGENTINA,
} from '../../common/utils/dias-argentina';
import {
  CUENTA_PARA_EL_RESULTADO,
  ES_CARGA_INICIAL,
} from './income-statement-rules';
import { aCentavos, dec } from '../../common/utils/dinero';
import { CashBoxKind } from '../domain/cash.enums';
import {
  CajaNoEncontradaError,
  MovimientoInvalidoError,
} from '../domain/errors/cash.errors';
import {
  IncomeStatementCategoryDto,
  IncomeStatementDto,
  IncomeStatementGroupBy,
  IncomeStatementPeriodDto,
  QueryIncomeStatementDto,
} from '../dto/cash-income-statement.dto';

interface FilaDeCategoria {
  category_id: string;
  name: string;
  system_code: IncomeStatementCategoryDto['systemCode'];
  direction: 'in' | 'out';
  amount: string;
  count: number;
}
interface FilaDeCargaInicial {
  amount: string;
  count: number;
}
interface FilaDePeriodo {
  period: string;
  income: string;
  expense: string;
}
interface FilaDeCaja {
  cash_box_id: string;
  name: string;
  kind: CashBoxKind;
  income: string;
  expense: string;
}

export const MAXIMO_DE_DIAS_DEL_RESULTADO = 366;

/**
 * Qué movimientos del libro cuentan como ingreso o egreso:
 * - las patas de una transferencia entre cajas y sus contraasientos no: es plata que
 *   cambia de caja, no que entra ni sale de la empresa;
 * - la carga inicial de una caja (la apertura de su primera sesión, sin movimientos
 *   previos) no: se informa aparte;
 * - el resto de los ajustes de apertura y de cierre sí: son sobrante o faltante real;
 * - un contraasiento cuenta en su propio período, con el signo opuesto, dentro de la
 *   categoría y el sentido de su original: un mes cerrado no cambia y el neto del mes
 *   es la variación de saldo de la caja.
 */
const MOVIMIENTOS_QUE_CUENTAN = `
  m."distributor_id" = $1 AND m."occurred_at" >= $2 AND m."occurred_at" < $3
  AND ($4::uuid IS NULL OR m."cash_box_id" = $4::uuid)
  AND ${CUENTA_PARA_EL_RESULTADO}`;

/** Del contraasiento valen la categoría y el sentido de su original, con el importe en negativo. */
const ORIGEN = `LEFT JOIN "cash_movement" o ON o."movement_id" = m."reverses_movement_id"`;
const SENTIDO = `COALESCE(o."direction", m."direction")`;
const CATEGORIA = `COALESCE(o."category_id", m."category_id")`;
const IMPORTE = `(CASE WHEN m."reverses_movement_id" IS NULL THEN m."amount" ELSE -m."amount" END)`;
const INGRESO = `COALESCE(SUM(${IMPORTE}) FILTER (WHERE ${SENTIDO} = 'in'), 0)::text`;
const EGRESO = `COALESCE(SUM(${IMPORTE}) FILTER (WHERE ${SENTIDO} = 'out'), 0)::text`;

const PERIODO_SQL: Record<IncomeStatementGroupBy, string> = {
  [IncomeStatementGroupBy.DAY]: 'day',
  [IncomeStatementGroupBy.WEEK]: 'week',
  [IncomeStatementGroupBy.MONTH]: 'month',
};

/** Primer día del período al que pertenece `dia`. */
function inicioDelPeriodo(dia: string, por: IncomeStatementGroupBy): string {
  if (por === IncomeStatementGroupBy.WEEK) return lunesDeLaSemana(dia);
  if (por === IncomeStatementGroupBy.MONTH) return primerDiaDelMes(dia);
  return dia;
}

function siguienteDelPeriodo(
  inicio: string,
  por: IncomeStatementGroupBy,
): string {
  if (por === IncomeStatementGroupBy.WEEK) return sumarDias(inicio, 7);
  if (por === IncomeStatementGroupBy.MONTH)
    return primerDiaDelMesSiguiente(inicio);
  return sumarDias(inicio, 1);
}

/** Todos los períodos del rango, con ceros donde no hubo movimientos. */
export function periodosDelRango(
  from: string,
  to: string,
  por: IncomeStatementGroupBy,
  filas: ReadonlyArray<{ period: string; income: string; expense: string }>,
): IncomeStatementPeriodDto[] {
  const porPeriodo = new Map(filas.map((f) => [f.period, f]));
  const salida: IncomeStatementPeriodDto[] = [];
  for (
    let p = inicioDelPeriodo(from, por);
    p <= to;
    p = siguienteDelPeriodo(p, por)
  ) {
    const f = porPeriodo.get(p);
    const income = dec(f?.income);
    const expense = dec(f?.expense);
    salida.push({
      // El primer período arranca en `from`, no en el lunes o el día 1 anteriores al rango.
      period: p < from ? from : p,
      income: aCentavos(income),
      expense: aCentavos(expense),
      net: aCentavos(income.minus(expense)),
    });
  }
  return salida;
}

/** Ingresos y egresos por período, categoría y caja, a partir del libro de Caja. */
@Injectable()
export class CashIncomeStatementService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async consultar(
    distributorId: string,
    query: QueryIncomeStatementDto,
  ): Promise<IncomeStatementDto> {
    const { from, to } = query;
    const groupBy = query.groupBy ?? IncomeStatementGroupBy.DAY;
    const rango = rangoDeDiasArgentinos(from, to);
    if (!rango) throw new MovimientoInvalidoError('El período no es válido');
    const dias = diasEntre(from, to) + 1;
    if (dias < 1) {
      throw new MovimientoInvalidoError(
        'La fecha inicial no puede ser posterior a la final',
      );
    }
    if (dias > MAXIMO_DE_DIAS_DEL_RESULTADO) {
      throw new MovimientoInvalidoError(
        `El período no puede pasar de ${MAXIMO_DE_DIAS_DEL_RESULTADO} días`,
      );
    }
    const cashBoxId = query.cashBoxId ?? null;
    const params = [distributorId, rango.desde, rango.hasta, cashBoxId];
    const local = `m."occurred_at" AT TIME ZONE '${ZONA_ARGENTINA}'`;
    // Una sola foto de la base: las tres vistas del reporte suman lo mismo aunque entren movimientos.
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    const leer = async <T>(sql: string, valores: unknown[]): Promise<T> =>
      (await runner.query(sql, valores)) as T;
    let categorias: FilaDeCategoria[];
    let periodos: FilaDePeriodo[];
    let cajas: FilaDeCaja[];
    let inicial: FilaDeCargaInicial[];
    try {
      await runner.query(
        'START TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (cashBoxId) {
        const caja = await leer<unknown[]>(
          `SELECT 1 FROM "cash_box" WHERE "cash_box_id" = $1 AND "distributor_id" = $2`,
          [cashBoxId, distributorId],
        );
        if (caja.length === 0) throw new CajaNoEncontradaError(cashBoxId);
      }
      categorias = await leer<FilaDeCategoria[]>(
        `SELECT c."category_id", c."name", c."system_code", ${SENTIDO} AS direction,
                SUM(${IMPORTE})::text AS amount, COUNT(*)::int AS count
           FROM "cash_movement" m ${ORIGEN}
           JOIN "cash_category" c ON c."category_id" = ${CATEGORIA}
          WHERE ${MOVIMIENTOS_QUE_CUENTAN}
          GROUP BY c."category_id", c."name", c."system_code", ${SENTIDO}
          ORDER BY ABS(SUM(${IMPORTE})) DESC, c."name"`,
        params,
      );
      periodos = await leer<FilaDePeriodo[]>(
        `SELECT to_char(date_trunc('${PERIODO_SQL[groupBy]}', ${local}), 'YYYY-MM-DD') AS period,
                ${INGRESO} AS income, ${EGRESO} AS expense
           FROM "cash_movement" m ${ORIGEN}
          WHERE ${MOVIMIENTOS_QUE_CUENTAN}
          GROUP BY 1`,
        params,
      );
      cajas = await leer<FilaDeCaja[]>(
        `SELECT b."cash_box_id", b."name", b."kind", ${INGRESO} AS income, ${EGRESO} AS expense
           FROM "cash_movement" m ${ORIGEN}
           JOIN "cash_box" b ON b."cash_box_id" = m."cash_box_id"
          WHERE ${MOVIMIENTOS_QUE_CUENTAN}
          GROUP BY b."cash_box_id", b."name", b."kind"
          ORDER BY b."name"`,
        params,
      );
      inicial = await leer<FilaDeCargaInicial[]>(
        `SELECT COALESCE(SUM(m."amount"), 0)::text AS amount, COUNT(*)::int AS count
           FROM "cash_movement" m
          WHERE m."distributor_id" = $1 AND m."occurred_at" >= $2 AND m."occurred_at" < $3
            AND ($4::uuid IS NULL OR m."cash_box_id" = $4::uuid)
            AND ${ES_CARGA_INICIAL}`,
        params,
      );
      await runner.query('COMMIT');
    } catch (error) {
      await runner.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await runner.release();
    }

    const byPeriod = periodosDelRango(from, to, groupBy, periodos);
    const income = byPeriod.reduce((s, p) => s.plus(p.income), dec(0));
    const expense = byPeriod.reduce((s, p) => s.plus(p.expense), dec(0));
    return {
      from,
      to,
      groupBy,
      totals: {
        income: aCentavos(income),
        expense: aCentavos(expense),
        net: aCentavos(income.minus(expense)),
      },
      byCategory: categorias.map((c) => ({
        categoryId: c.category_id,
        name: c.name,
        systemCode: c.system_code,
        direction: c.direction,
        amount: aCentavos(c.amount),
        count: c.count,
      })),
      initialLoad: {
        amount: aCentavos(inicial[0]?.amount ?? 0),
        count: inicial[0]?.count ?? 0,
      },
      byPeriod,
      byCashBox: cajas.map((c) => ({
        cashBoxId: c.cash_box_id,
        name: c.name,
        kind: c.kind,
        income: aCentavos(c.income),
        expense: aCentavos(c.expense),
      })),
    } satisfies IncomeStatementDto;
  }
}
