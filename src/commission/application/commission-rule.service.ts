import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { traducirErrorDeBase } from '../../common/errors/db-exceptions';
import { Employee } from '../../employee/entities/employee.entity';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { seSolapan, validarRegla } from '../domain/commission-rules';
import {
  ComisionConflictoError,
  EmpleadoNoEncontradoError,
  ProductoNoEncontradoError,
  ReglaNoEncontradaError,
} from '../domain/errors/commission.errors';
import {
  CreateCommissionRuleDto,
  QueryCommissionRuleDto,
  UpdateCommissionRuleDto,
} from '../dto/commission.dto';
import { CommissionRule } from '../entities/commission-rule.entity';

export interface ReglaConNombres {
  regla: CommissionRule;
  employeeName: string | null;
  gasCylinderType: string | null;
}

/** Reglas de comisión por entrega (CU-240, CU-333). */
@Injectable()
export class CommissionRuleService {
  private readonly logger = new Logger(CommissionRuleService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findAll(
    distributorId: string,
    query: QueryCommissionRuleDto,
  ): Promise<{ data: ReglaConNombres[]; total: number }> {
    const limit = query.limit ?? 50;
    const qb = this.dataSource.manager
      .createQueryBuilder(CommissionRule, 'r')
      .where('r.distributorId = :distributorId', { distributorId });
    if (query.employeeId) {
      qb.andWhere('r.employeeId = :employeeId', {
        employeeId: query.employeeId,
      });
    }
    if (query.gasCylinderId) {
      qb.andWhere('r.gasCylinderId = :gasCylinderId', {
        gasCylinderId: query.gasCylinderId,
      });
    }
    if (query.activeOnly) qb.andWhere('r.isActive = true');
    const [reglas, total] = await qb
      .orderBy('r.validFrom', 'DESC')
      .addOrderBy('r.createdAt', 'DESC')
      .skip(((query.page ?? 1) - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data: await this.conNombres(reglas), total };
  }

  async create(
    dto: CreateCommissionRuleDto,
    distributorId: string,
  ): Promise<ReglaConNombres> {
    const validTo = dto.validTo ?? null;
    validarRegla({
      basis: dto.basis,
      value: dto.value,
      validFrom: dto.validFrom,
      validTo,
    });
    const regla = await this.dataSource.transaction(async (manager) => {
      await this.bloquearReglasDe(manager, distributorId);
      await this.asegurarAlcance(
        manager,
        distributorId,
        dto.employeeId ?? null,
        dto.gasCylinderId ?? null,
      );
      const nueva = manager.create(CommissionRule, {
        distributorId,
        employeeId: dto.employeeId ?? null,
        gasCylinderId: dto.gasCylinderId ?? null,
        basis: dto.basis,
        value: dto.value,
        validFrom: dto.validFrom,
        validTo,
        isActive: true,
      });
      await this.asegurarSinSolapamiento(manager, nueva);
      try {
        return await manager.save(nueva);
      } catch (error) {
        return traducirErrorDeBase(error, this.logger, 'reglas de comisión');
      }
    });
    return (await this.conNombres([regla]))[0];
  }

  async update(
    id: string,
    dto: UpdateCommissionRuleDto,
    distributorId: string,
  ): Promise<ReglaConNombres> {
    const regla = await this.dataSource.transaction(async (manager) => {
      await this.bloquearReglasDe(manager, distributorId);
      const regla = await manager.findOne(CommissionRule, {
        where: { ruleId: id, distributorId },
      });
      if (!regla) throw new ReglaNoEncontradaError(id);
      if (dto.basis !== undefined) regla.basis = dto.basis;
      if (dto.value !== undefined) regla.value = dto.value;
      if (dto.validFrom !== undefined) regla.validFrom = dto.validFrom;
      if (dto.validTo !== undefined) regla.validTo = dto.validTo;
      if (dto.isActive !== undefined) regla.isActive = dto.isActive;
      validarRegla(regla);
      if (regla.isActive) await this.asegurarSinSolapamiento(manager, regla);
      try {
        return await manager.save(regla);
      } catch (error) {
        return traducirErrorDeBase(error, this.logger, 'reglas de comisión');
      }
    });
    return (await this.conNombres([regla]))[0];
  }

  /**
   * Serializa las altas y cambios de reglas de una distribuidora: la validación
   * de solapamiento lee y después escribe, y dos al mismo tiempo no se verían.
   */
  private async bloquearReglasDe(
    manager: EntityManager,
    distributorId: string,
  ): Promise<void> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `commission_rule:${distributorId}`,
    ]);
  }

  /** El empleado y el producto tienen que ser de la distribuidora (404). */
  private async asegurarAlcance(
    manager: EntityManager,
    distributorId: string,
    employeeId: string | null,
    gasCylinderId: string | null,
  ): Promise<void> {
    if (employeeId) {
      const existe = await manager.exists(Employee, {
        where: { employeeId, distributorId },
      });
      if (!existe) throw new EmpleadoNoEncontradoError(employeeId);
    }
    if (gasCylinderId) {
      const existe = await manager.exists(GasCylinder, {
        where: { gasCylinderId, distributorId },
      });
      if (!existe) throw new ProductoNoEncontradoError(gasCylinderId);
    }
  }

  private async asegurarSinSolapamiento(
    manager: EntityManager,
    regla: CommissionRule,
  ): Promise<void> {
    const mismas = await manager.find(CommissionRule, {
      where: {
        distributorId: regla.distributorId,
        isActive: true,
        employeeId: regla.employeeId ?? undefined,
        gasCylinderId: regla.gasCylinderId ?? undefined,
      },
    });
    const choque = mismas.find(
      (otra) => otra.ruleId !== regla.ruleId && seSolapan(otra, regla),
    );
    if (choque) {
      throw new ComisionConflictoError(
        `Se solapa con otra regla vigente del mismo alcance (desde ${choque.validFrom}${choque.validTo ? ` hasta ${choque.validTo}` : ', sin fin'}): cerrá esa regla antes de crear o cambiar ésta`,
      );
    }
  }

  private async conNombres(
    reglas: CommissionRule[],
  ): Promise<ReglaConNombres[]> {
    if (reglas.length === 0) return [];
    const empleados: Array<{ employee_id: string; nombre: string }> =
      await this.dataSource.query(
        `SELECT "employee_id", ("first_name" || ' ' || "last_name") AS nombre
         FROM "employee" WHERE "employee_id" = ANY($1::uuid[])`,
        [reglas.map((r) => r.employeeId).filter((x): x is string => !!x)],
      );
    const garrafas: Array<{ gas_cylinder_id: string; type: string }> =
      await this.dataSource.query(
        `SELECT "gas_cylinder_id", "type" FROM "gas_cylinder" WHERE "gas_cylinder_id" = ANY($1::uuid[])`,
        [reglas.map((r) => r.gasCylinderId).filter((x): x is string => !!x)],
      );
    return reglas.map((regla) => ({
      regla,
      employeeName:
        empleados.find((e) => e.employee_id === regla.employeeId)?.nombre ??
        null,
      gasCylinderType:
        garrafas.find((g) => g.gas_cylinder_id === regla.gasCylinderId)?.type ??
        null,
    }));
  }
}
