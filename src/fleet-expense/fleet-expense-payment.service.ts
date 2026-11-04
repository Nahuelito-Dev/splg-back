import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import { CashDocumentPaymentService } from '../cash/application/cash-document-payment.service';
import { CashReferenceType, CashSystemCode } from '../cash/domain/cash.enums';
import { instanteValido } from '../cash/domain/instante-del-pago';
import { PayFromCashBoxDto } from '../cash/dto/pay-expense.dto';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { diaArgentino } from '../common/utils/dias-argentina';
import {
  PayAccidentDto,
  ReceiveReimbursementDto,
} from './dto/fleet-expense-v2.dto';
import { Tire } from './entities/tire.entity';
import { VehicleAccident } from './entities/vehicle-accident.entity';
import { rutaLegible } from '../common/validation/etiquetas';

/**
 * Pago de los gastos de la flota que no son combustible ni multas (API v2): la
 * compra de un neumático y lo que paga la empresa por un siniestro, más el
 * reintegro del seguro que entra a la caja. Cada pago es una transacción con la
 * fila bloqueada, una sola vez por gasto.
 */
@Injectable()
export class FleetExpensePaymentService {
  private readonly logger = new Logger(FleetExpensePaymentService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pagos: CashDocumentPaymentService,
  ) {}

  /** Egreso de la compra del neumático, por su costo. */
  async pagarNeumatico(
    id: string,
    dto: PayFromCashBoxDto,
    distributorId: string,
    userId: string,
  ): Promise<void> {
    const pagadoEn = instanteValido(dto.paidAt, 'paidAt');
    try {
      await this.dataSource.transaction(async (manager) => {
        const neumatico = await manager.getRepository(Tire).findOne({
          where: { tireId: id, distributorId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!neumatico) {
          throw new NotFoundException('Neumático no encontrado');
        }
        if (neumatico.cashMovementId) {
          throw new ConflictException('El neumático ya está pago');
        }
        if (diaArgentino(pagadoEn) < diaArgentino(neumatico.createdAt)) {
          throw new BadRequestException(
            'Fecha de pago: no puede ser anterior a la compra del neumático',
          );
        }
        if (neumatico.cost <= 0) {
          throw new ConflictException(
            'El neumático no tiene un costo para pagar',
          );
        }
        const movimiento = await this.pagos.pagarDesdeUnaCaja(manager, {
          distributorId,
          cashBoxId: dto.cashBoxId,
          amount: neumatico.cost,
          systemCode: CashSystemCode.TIRES,
          referenceType: CashReferenceType.TIRE,
          referenceId: id,
          description: `Neumático ${neumatico.brand} ${neumatico.size} (serie ${neumatico.serialNumber})`,
          userId,
        });
        neumatico.cashMovementId = movimiento.movementId;
        neumatico.paidAt = pagadoEn;
        await manager.getRepository(Tire).save(neumatico);
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'neumáticos');
    }
  }

  /** Egreso de lo que pagó la empresa por el siniestro (reparación o franquicia). */
  async pagarSiniestro(
    id: string,
    dto: PayAccidentDto,
    distributorId: string,
    userId: string,
  ): Promise<void> {
    const pagadoEn = instanteValido(dto.paidAt, 'paidAt');
    try {
      await this.dataSource.transaction(async (manager) => {
        const siniestro = await this.bloquearSiniestro(
          manager,
          id,
          distributorId,
        );
        if (siniestro.paymentCashMovementId) {
          throw new ConflictException(
            'El siniestro ya tiene su pago registrado',
          );
        }
        this.assertNoEsAnteriorAlSiniestro(siniestro, pagadoEn, 'paidAt');
        const tope = this.topeDelPago(siniestro);
        if (tope && new Decimal(dto.amount).gt(tope)) {
          throw new BadRequestException(
            `Importe: no puede superar lo cargado al cerrar el siniestro (${tope.toFixed(2)})`,
          );
        }
        const movimiento = await this.pagos.pagarDesdeUnaCaja(manager, {
          distributorId,
          cashBoxId: dto.cashBoxId,
          amount: dto.amount,
          systemCode: CashSystemCode.VEHICLE_ACCIDENT,
          referenceType: CashReferenceType.VEHICLE_ACCIDENT,
          referenceId: id,
          description: await this.descripcion(
            manager,
            'Pago del siniestro',
            siniestro,
          ),
          userId,
        });
        siniestro.paymentCashMovementId = movimiento.movementId;
        siniestro.paymentPaidAt = pagadoEn;
        siniestro.paymentAmount = dto.amount;
        await manager.getRepository(VehicleAccident).save(siniestro);
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'siniestros');
    }
  }

  /** Ingreso del reintegro que pagó el seguro por el siniestro. */
  async registrarReintegro(
    id: string,
    dto: ReceiveReimbursementDto,
    distributorId: string,
    userId: string,
  ): Promise<void> {
    const recibidoEn = instanteValido(dto.receivedAt, 'receivedAt');
    try {
      await this.dataSource.transaction(async (manager) => {
        const siniestro = await this.bloquearSiniestro(
          manager,
          id,
          distributorId,
        );
        if (siniestro.reimbursementCashMovementId) {
          throw new ConflictException(
            'El siniestro ya tiene su reintegro registrado',
          );
        }
        this.assertNoEsAnteriorAlSiniestro(siniestro, recibidoEn, 'receivedAt');
        if (siniestro.closedAt) {
          const cargado = new Decimal(siniestro.insurerReimbursement ?? 0);
          if (cargado.lte(0)) {
            throw new ConflictException(
              'El siniestro se cerró sin reintegro del seguro',
            );
          }
          if (new Decimal(dto.amount).gt(cargado)) {
            throw new BadRequestException(
              `Importe: no puede superar el reintegro cargado al cerrar el siniestro (${cargado.toFixed(2)})`,
            );
          }
        }
        const movimiento = await this.pagos.cobrarEnUnaCaja(manager, {
          distributorId,
          cashBoxId: dto.cashBoxId,
          amount: dto.amount,
          systemCode: CashSystemCode.INSURANCE_REIMBURSEMENT,
          referenceType: CashReferenceType.INSURANCE_REIMBURSEMENT,
          referenceId: id,
          description: await this.descripcion(
            manager,
            'Reintegro del seguro',
            siniestro,
          ),
          userId,
        });
        siniestro.reimbursementCashMovementId = movimiento.movementId;
        siniestro.reimbursementReceivedAt = recibidoEn;
        siniestro.reimbursementAmount = dto.amount;
        await manager.getRepository(VehicleAccident).save(siniestro);
      });
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'siniestros');
    }
  }

  private async bloquearSiniestro(
    manager: EntityManager,
    id: string,
    distributorId: string,
  ): Promise<VehicleAccident> {
    const siniestro = await manager.getRepository(VehicleAccident).findOne({
      where: { accidentId: id, distributorId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!siniestro) {
      throw new NotFoundException('Siniestro no encontrado');
    }
    return siniestro;
  }

  /**
   * Lo máximo que puede haber pagado la empresa: con el siniestro cerrado, el
   * costo de la reparación o la franquicia, el que sea mayor; abierto, no hay
   * un importe contra el cual validar.
   */
  private topeDelPago(siniestro: VehicleAccident): Decimal | null {
    if (!siniestro.closedAt) return null;
    return Decimal.max(
      siniestro.repairCost ?? 0,
      siniestro.deductibleAmount ?? 0,
    );
  }

  private assertNoEsAnteriorAlSiniestro(
    siniestro: VehicleAccident,
    instante: Date,
    campo: string,
  ): void {
    if (diaArgentino(instante) < diaArgentino(siniestro.occurredAt)) {
      throw new BadRequestException(
        `${rutaLegible(campo.split('.'))}: no puede ser anterior a la fecha del siniestro`,
      );
    }
  }

  private async descripcion(
    manager: EntityManager,
    que: string,
    siniestro: VehicleAccident,
  ): Promise<string> {
    const filas: Array<{ patente: string | null }> = await manager.query(
      `SELECT "car_patent" AS patente FROM "car" WHERE "car_id" = $1 AND "distributor_id" = $2`,
      [siniestro.carId, siniestro.distributorId],
    );
    return `${que} del ${diaArgentino(siniestro.occurredAt)} — ${filas[0]?.patente ?? siniestro.carId}`;
  }
}
