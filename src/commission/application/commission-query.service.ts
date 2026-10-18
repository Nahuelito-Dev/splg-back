import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { empleadoDelUsuario } from '../../common/tenancy/chofer-empleado';
import { rangoDeDiasArgentinos } from '../../common/utils/dias-argentina';
import { aCentavos, dec } from '../../common/utils/dinero';
import { ComisionInvalidaError } from '../domain/errors/commission.errors';
import {
  QueryCommissionEntryDto,
  QueryMyCommissionsDto,
} from '../dto/commission.dto';
import { CommissionEntry } from '../entities/commission-entry.entity';

export interface AsientoConNombre {
  asiento: CommissionEntry;
  employeeName: string;
}

export interface PaginaDeAsientos {
  data: AsientoConNombre[];
  total: number;
  totalAmount: number;
}

/** Consulta de los asientos de comisión (admin) y de las propias del chofer (CU-244). */
@Injectable()
export class CommissionQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findAll(
    distributorId: string,
    query: QueryCommissionEntryDto,
  ): Promise<PaginaDeAsientos> {
    const qb = this.dataSource.manager
      .createQueryBuilder(CommissionEntry, 'c')
      .where('c.distributorId = :distributorId', { distributorId });
    if (query.employeeId) {
      qb.andWhere('c.employeeId = :employeeId', {
        employeeId: query.employeeId,
      });
    }
    if (query.type) qb.andWhere('c.type = :type', { type: query.type });
    if (query.liquidated === true) qb.andWhere('c.liquidationId IS NOT NULL');
    if (query.liquidated === false) qb.andWhere('c.liquidationId IS NULL');
    this.acotarPeriodo(qb, query.from, query.to);
    return this.pagina(qb, query.page ?? 1, query.limit ?? 20);
  }

  /** Mis comisiones: 404 si quien pide no tiene perfil de chofer con legajo. */
  async mias(
    userId: string,
    distributorId: string,
    query: QueryMyCommissionsDto,
  ): Promise<
    PaginaDeAsientos & { pendingAmount: number; liquidatedAmount: number }
  > {
    const empleado = await empleadoDelUsuario(
      this.dataSource.manager,
      userId,
      distributorId,
    );
    if (!empleado) {
      throw new NotFoundException('No hay un perfil de chofer para tu usuario');
    }
    const base = (): SelectQueryBuilder<CommissionEntry> => {
      const qb = this.dataSource.manager
        .createQueryBuilder(CommissionEntry, 'c')
        .where('c.employeeId = :employeeId', {
          employeeId: empleado.employeeId,
        });
      this.acotarPeriodo(qb, query.from, query.to);
      return qb;
    };
    const pagina = await this.pagina(
      base(),
      query.page ?? 1,
      query.limit ?? 20,
    );
    const suma = async (filtro: string): Promise<number> => {
      const fila = await base()
        .andWhere(filtro)
        .select('COALESCE(SUM(c.amount), 0)', 'total')
        .getRawOne<{ total: string }>();
      return aCentavos(dec(fila?.total));
    };
    return {
      ...pagina,
      pendingAmount: await suma('c.liquidationId IS NULL'),
      liquidatedAmount: await suma('c.liquidationId IS NOT NULL'),
    };
  }

  /** Lo todavía no liquidado de toda la distribuidora, para el tablero. */
  async pendienteDeLiquidar(distributorId: string): Promise<{
    amount: number;
    employees: number;
  }> {
    const [fila]: Array<{ total: string; empleados: number }> =
      await this.dataSource.query(
        `SELECT COALESCE(SUM("amount"), 0)::text AS total,
                COUNT(DISTINCT "employee_id")::int AS empleados
         FROM "commission_entry"
         WHERE "distributor_id" = $1 AND "liquidation_id" IS NULL`,
        [distributorId],
      );
    return { amount: aCentavos(dec(fila.total)), employees: fila.empleados };
  }

  private acotarPeriodo(
    qb: SelectQueryBuilder<CommissionEntry>,
    from?: string,
    to?: string,
  ): void {
    if (!from && !to) return;
    if (from && to && from > to) {
      throw new ComisionInvalidaError(
        'La fecha inicial no puede ser posterior a la final',
      );
    }
    const rango = rangoDeDiasArgentinos(from ?? to ?? '', to ?? from ?? '');
    if (!rango) throw new ComisionInvalidaError('El período no es válido');
    if (from) qb.andWhere('c.occurredAt >= :desde', { desde: rango.desde });
    if (to) qb.andWhere('c.occurredAt < :hasta', { hasta: rango.hasta });
  }

  private async pagina(
    qb: SelectQueryBuilder<CommissionEntry>,
    page: number,
    limit: number,
  ): Promise<PaginaDeAsientos> {
    const total = await qb.getCount();
    const suma = await qb
      .clone()
      .select('COALESCE(SUM(c.amount), 0)', 'total')
      .getRawOne<{ total: string }>();
    const asientos = await qb
      .clone()
      .orderBy('c.occurredAt', 'DESC')
      .addOrderBy('c.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();
    return {
      data: await this.conNombres(asientos),
      total,
      totalAmount: aCentavos(new Decimal(suma?.total ?? 0)),
    };
  }

  async conNombres(asientos: CommissionEntry[]): Promise<AsientoConNombre[]> {
    if (asientos.length === 0) return [];
    const filas: Array<{ employee_id: string; nombre: string }> =
      await this.dataSource.query(
        `SELECT "employee_id", ("first_name" || ' ' || "last_name") AS nombre
         FROM "employee" WHERE "employee_id" = ANY($1::uuid[])`,
        [[...new Set(asientos.map((a) => a.employeeId))]],
      );
    return asientos.map((asiento) => ({
      asiento,
      employeeName:
        filas.find((f) => f.employee_id === asiento.employeeId)?.nombre ?? '',
    }));
  }
}
