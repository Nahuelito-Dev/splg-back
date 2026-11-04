import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import { CashLedgerService } from '../../cash/application/cash-ledger.service';
import { sentidoOpuesto } from '../../cash/domain/cash-rules';
import { CashMovement } from '../../cash/entities/cash-movement.entity';
import { CashCategoryService } from '../../cash/application/cash-category.service';
import {
  CashDirection,
  CashReferenceType,
  CashSystemCode,
} from '../../cash/domain/cash.enums';
import { rangoDeDiasArgentinos } from '../../common/utils/dias-argentina';
import { aCentavos, dec } from '../../common/utils/dinero';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import {
  DocType,
  DocumentSequenceService,
} from '../../document-sequence/document-sequence.service';
import { exigirEstadoDeLiquidacion } from '../domain/commission-rules';
import { LiquidationStatus } from '../domain/commission.enums';
import {
  ComisionConflictoError,
  ComisionInvalidaError,
  EmpleadoNoEncontradoError,
  LiquidacionNoEncontradaError,
} from '../domain/errors/commission.errors';
import {
  CreateDriverLiquidationDto,
  QueryDriverLiquidationDto,
} from '../dto/driver-liquidation.dto';
import { CommissionEntry } from '../entities/commission-entry.entity';
import { DriverLiquidation } from '../entities/driver-liquidation.entity';
import { Employee } from '../../employee/entities/employee.entity';

export interface LiquidacionConEmpleado {
  liquidacion: DriverLiquidation;
  employeeName: string;
}

/**
 * Liquidación de las comisiones de un chofer (CU-242, 243, 334, 335): toma bajo
 * lock los asientos sin liquidar del período, se aprueba (congela), se paga con
 * un egreso de caja o se anula (libera los asientos).
 */
@Injectable()
export class DriverLiquidationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly secuencia: DocumentSequenceService,
    private readonly ledger: CashLedgerService,
    private readonly categorias: CashCategoryService,
  ) {}

  async crear(
    dto: CreateDriverLiquidationDto,
    distributorId: string,
    userId: string,
  ): Promise<LiquidacionConEmpleado> {
    if (dto.periodFrom > dto.periodTo) {
      throw new ComisionInvalidaError(
        'El período no es válido: «Período desde» no puede ser posterior a «Período hasta»',
      );
    }
    const rango = rangoDeDiasArgentinos(dto.periodFrom, dto.periodTo);
    if (!rango) throw new ComisionInvalidaError('El período no es válido');

    const liquidacion = await withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const empleado = await manager.findOne(Employee, {
            where: { employeeId: dto.employeeId, distributorId },
          });
          if (!empleado) throw new EmpleadoNoEncontradoError(dto.employeeId);
          // Los períodos de un chofer no se pisan (salvo los de liquidaciones
          // anuladas): la base lo exige con EXC_driver_liquidation_periodo_solapado.
          const solapada = await manager
            .createQueryBuilder(DriverLiquidation, 'l')
            .where('l.employeeId = :employeeId', { employeeId: dto.employeeId })
            .andWhere('l.distributorId = :distributorId', { distributorId })
            .andWhere('l.status <> :anulada', {
              anulada: LiquidationStatus.VOIDED,
            })
            .andWhere('l.periodFrom <= :hasta AND l.periodTo >= :desde', {
              desde: dto.periodFrom,
              hasta: dto.periodTo,
            })
            .getOne();
          if (solapada) {
            throw new ComisionConflictoError(
              `El período se superpone con la liquidación N° ${solapada.number} del chofer (${solapada.periodFrom} al ${solapada.periodTo}): anulala o elegí otro período`,
            );
          }
          // Los asientos van primero y bloqueados: dos liquidaciones del mismo
          // chofer no pueden tomar el mismo.
          const asientos = await manager
            .createQueryBuilder(CommissionEntry, 'c')
            .setLock('pessimistic_write')
            .where('c.employeeId = :employeeId', {
              employeeId: dto.employeeId,
            })
            .andWhere('c.distributorId = :distributorId', { distributorId })
            .andWhere('c.liquidationId IS NULL')
            .andWhere('c.occurredAt >= :desde AND c.occurredAt < :hasta', rango)
            .orderBy('c.occurredAt', 'ASC')
            .getMany();
          if (asientos.length === 0) {
            throw new ComisionConflictoError(
              'No hay comisiones para liquidar en el período',
            );
          }
          let bruto = new Decimal(0);
          let deducciones = new Decimal(0);
          for (const a of asientos) {
            if (a.amount >= 0) bruto = bruto.plus(a.amount);
            else deducciones = deducciones.plus(new Decimal(a.amount).abs());
          }
          // La numeración va al final del orden de locks para no dejar huecos.
          const numero = await this.secuencia.siguienteNumero(
            manager,
            distributorId,
            DocType.DRIVER_LIQUIDATION,
          );
          const nueva = await manager.save(
            manager.create(DriverLiquidation, {
              distributorId,
              number: numero,
              employeeId: dto.employeeId,
              periodFrom: dto.periodFrom,
              periodTo: dto.periodTo,
              gross: aCentavos(bruto),
              deductions: aCentavos(deducciones),
              net: aCentavos(bruto.minus(deducciones)),
              status: LiquidationStatus.DRAFT,
              createdByUserId: userId,
            }),
          );
          await manager.query(
            `UPDATE "commission_entry" SET "liquidation_id" = $1
             WHERE "entry_id" = ANY($2::uuid[])`,
            [nueva.liquidationId, asientos.map((a) => a.entryId)],
          );
          return nueva;
        }),
      { context: 'DriverLiquidationService.crear' },
    );
    return (await this.conEmpleados([liquidacion]))[0];
  }

  async aprobar(
    id: string,
    distributorId: string,
    userId: string,
  ): Promise<LiquidacionConEmpleado> {
    const liquidacion = await this.dataSource.transaction(async (manager) => {
      const l = await this.bloquear(manager, id, distributorId);
      exigirEstadoDeLiquidacion(l.status, 'approve');
      l.status = LiquidationStatus.APPROVED;
      l.approvedAt = new Date();
      l.approvedByUserId = userId;
      return manager.save(l);
    });
    return (await this.conEmpleados([liquidacion]))[0];
  }

  /**
   * Paga una liquidación aprobada con un egreso de su neto en la caja (por el
   * punto único del libro). Bloqueo: la liquidación y después la caja.
   */
  async pagar(
    id: string,
    cashBoxId: string,
    distributorId: string,
    userId: string,
  ): Promise<LiquidacionConEmpleado> {
    const liquidacion = await withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const l = await this.bloquear(manager, id, distributorId);
          exigirEstadoDeLiquidacion(l.status, 'pay');
          if (dec(l.net).lte(0)) {
            throw new ComisionConflictoError(
              'El neto de la liquidación no es positivo: no hay nada que pagar',
            );
          }
          const categoria = await this.categorias.deSistema(
            manager,
            distributorId,
            CashSystemCode.COMMISSION_PAYMENT,
          );
          const movimiento = await this.ledger.registrar(manager, {
            distributorId,
            cashBoxId,
            direction: CashDirection.OUT,
            amount: l.net,
            categoryId: categoria.categoryId,
            description: `Pago de la liquidación N° ${l.number}`,
            referenceType: CashReferenceType.DRIVER_LIQUIDATION,
            referenceId: l.liquidationId,
            userId,
          });
          l.status = LiquidationStatus.PAID;
          l.paidAt = new Date();
          l.paidByUserId = userId;
          l.cashMovementId = movimiento.movementId;
          return manager.save(l);
        }),
      { context: 'DriverLiquidationService.pagar' },
    );
    return (await this.conEmpleados([liquidacion]))[0];
  }

  /**
   * Anula el pago de una liquidación pagada: contraasiento en la misma caja del
   * pago (entra el neto) y la liquidación vuelve a aprobada, lista para pagarse
   * de nuevo o anularse. Bloqueo: la liquidación y después la caja.
   */
  async anularPago(
    id: string,
    reason: string,
    distributorId: string,
    userId: string,
  ): Promise<LiquidacionConEmpleado> {
    const liquidacion = await withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const l = await this.bloquear(manager, id, distributorId);
          exigirEstadoDeLiquidacion(l.status, 'unpay');
          const pago = l.cashMovementId
            ? await manager.findOne(CashMovement, {
                where: { movementId: l.cashMovementId, distributorId },
              })
            : null;
          if (!pago) {
            throw new ComisionConflictoError(
              'La liquidación no tiene el movimiento de caja de su pago',
            );
          }
          await this.ledger.bloquearCajas(
            manager,
            [pago.cashBoxId],
            distributorId,
          );
          await this.ledger.registrar(manager, {
            distributorId,
            cashBoxId: pago.cashBoxId,
            direction: sentidoOpuesto(pago.direction),
            amount: pago.amount,
            categoryId: pago.categoryId,
            method: pago.method,
            description:
              `Anulación del pago de la liquidación N° ${l.number}: ${reason}`.slice(
                0,
                255,
              ),
            referenceType: CashReferenceType.REVERSAL,
            referenceId: pago.movementId,
            reversesMovementId: pago.movementId,
            userId,
            esContraasiento: true,
          });
          l.status = LiquidationStatus.APPROVED;
          l.paidAt = null;
          l.paidByUserId = null;
          l.cashMovementId = null;
          return manager.save(l);
        }),
      { context: 'DriverLiquidationService.anularPago' },
    );
    return (await this.conEmpleados([liquidacion]))[0];
  }

  /** Anula una liquidación en borrador o aprobada y libera sus asientos. */
  async anular(
    id: string,
    distributorId: string,
  ): Promise<LiquidacionConEmpleado> {
    const liquidacion = await this.dataSource.transaction(async (manager) => {
      const l = await this.bloquear(manager, id, distributorId);
      exigirEstadoDeLiquidacion(l.status, 'void');
      await manager.query(
        `UPDATE "commission_entry" SET "liquidation_id" = NULL WHERE "liquidation_id" = $1`,
        [id],
      );
      l.status = LiquidationStatus.VOIDED;
      l.voidedAt = new Date();
      return manager.save(l);
    });
    return (await this.conEmpleados([liquidacion]))[0];
  }

  async findAll(
    distributorId: string,
    query: QueryDriverLiquidationDto,
  ): Promise<{ data: LiquidacionConEmpleado[]; total: number }> {
    const qb = this.dataSource.manager
      .createQueryBuilder(DriverLiquidation, 'l')
      .where('l.distributorId = :distributorId', { distributorId });
    if (query.employeeId) {
      qb.andWhere('l.employeeId = :employeeId', {
        employeeId: query.employeeId,
      });
    }
    if (query.status)
      qb.andWhere('l.status = :status', { status: query.status });
    if (query.from) qb.andWhere('l.periodTo >= :from', { from: query.from });
    if (query.to) qb.andWhere('l.periodFrom <= :to', { to: query.to });
    const limit = query.limit ?? 20;
    const [liquidaciones, total] = await qb
      .orderBy('l.number', 'DESC')
      .skip(((query.page ?? 1) - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data: await this.conEmpleados(liquidaciones), total };
  }

  async findOne(
    id: string,
    distributorId: string,
  ): Promise<{
    item: LiquidacionConEmpleado;
    asientos: CommissionEntry[];
  }> {
    const l = await this.dataSource.manager.findOne(DriverLiquidation, {
      where: { liquidationId: id, distributorId },
    });
    if (!l) throw new LiquidacionNoEncontradaError(id);
    const asientos = await this.dataSource.manager.find(CommissionEntry, {
      where: { liquidationId: id },
      order: { occurredAt: 'ASC' },
    });
    return { item: (await this.conEmpleados([l]))[0], asientos };
  }

  private async bloquear(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<DriverLiquidation> {
    const l = await manager.findOne(DriverLiquidation, {
      where: { liquidationId: id, distributorId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!l) throw new LiquidacionNoEncontradaError(id);
    return l;
  }

  private async conEmpleados(
    liquidaciones: DriverLiquidation[],
  ): Promise<LiquidacionConEmpleado[]> {
    if (liquidaciones.length === 0) return [];
    const filas: Array<{ employee_id: string; nombre: string }> =
      await this.dataSource.query(
        `SELECT "employee_id", ("first_name" || ' ' || "last_name") AS nombre
         FROM "employee" WHERE "employee_id" = ANY($1::uuid[])`,
        [[...new Set(liquidaciones.map((l) => l.employeeId))]],
      );
    return liquidaciones.map((liquidacion) => ({
      liquidacion,
      employeeName:
        filas.find((f) => f.employee_id === liquidacion.employeeId)?.nombre ??
        '',
    }));
  }
}
