import { BadRequestException, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { EntityManager } from 'typeorm';
import { sentidoOpuesto } from '../domain/cash-rules';
import {
  CashBoxKind,
  CashDirection,
  CashMethod,
  CashReferenceType,
  CashSystemCode,
} from '../domain/cash.enums';
import {
  CajaNoEncontradaError,
  MovimientoNoEncontradoError,
} from '../domain/errors/cash.errors';
import { CashMovement } from '../entities/cash-movement.entity';
import { CashCategoryService } from './cash-category.service';
import { CashLedgerService } from './cash-ledger.service';

export interface EgresoDeDocumento {
  distributorId: string;
  cashBoxId: string;
  amount: Decimal.Value;
  /** Categoría de sistema del gasto (compra, combustible, multa, seguro). */
  systemCode: CashSystemCode;
  referenceType: CashReferenceType;
  referenceId: string;
  description: string;
  userId: string;
  /** Medio con que se pagó; por omisión, efectivo. */
  method?: CashMethod;
}

const SOLO_EFECTIVO: readonly CashBoxKind[] = [CashBoxKind.CASH];

/**
 * El efectivo que la distribuidora paga por un documento (compra a la planta,
 * multa, combustible) sale de una caja de efectivo por el libro, en la
 * transacción del documento. Quien llama ya bloqueó su documento: el orden de
 * locks es documento → caja.
 */
@Injectable()
export class CashDocumentPaymentService {
  constructor(
    private readonly ledger: CashLedgerService,
    private readonly categorias: CashCategoryService,
  ) {}

  /**
   * Regla de la caja: si la distribuidora tiene alguna caja de efectivo activa,
   * el pago en efectivo TIENE que indicar de cuál sale (400); si no tiene
   * ninguna, se paga sin movimiento y devuelve `null`. Una caja que no es de
   * efectivo es 400; una inexistente o de otra distribuidora, 404.
   *
   * `clasesAdmitidas` amplía qué cajas aceptan el pago (por omisión sólo
   * efectivo): un pago que sale de una cuenta de banco o de una billetera pasa
   * `[CASH, BANK, WALLET]`. La regla de «cuál caja es obligatoria» sigue siendo
   * la del efectivo: quien admite banco o billetera siempre indica la caja.
   */
  async cajaDelPago(
    manager: EntityManager,
    distributorId: string,
    cashBoxId?: string | null,
    clasesAdmitidas: readonly CashBoxKind[] = SOLO_EFECTIVO,
  ): Promise<string | null> {
    if (cashBoxId) {
      const filas: Array<{ kind: CashBoxKind }> = await manager.query(
        `SELECT "kind" FROM "cash_box"
         WHERE "cash_box_id" = $1 AND "distributor_id" = $2 AND "deletedAt" IS NULL`,
        [cashBoxId, distributorId],
      );
      if (!filas[0]) throw new CajaNoEncontradaError(cashBoxId);
      if (!clasesAdmitidas.includes(filas[0].kind)) {
        throw new BadRequestException(
          clasesAdmitidas.length === 1
            ? 'El efectivo sale de una caja de efectivo: elegí otra caja'
            : 'La caja elegida no admite este pago: elegí una caja de efectivo, de banco o de billetera',
        );
      }
      return cashBoxId;
    }
    const filas: Array<{ n: string }> = await manager.query(
      `SELECT count(*) AS n FROM "cash_box"
       WHERE "distributor_id" = $1 AND "is_active" = true AND "kind" = 'cash' AND "deletedAt" IS NULL`,
      [distributorId],
    );
    if (Number(filas[0]?.n ?? 0) > 0) {
      throw new BadRequestException(
        'Indicá la caja de efectivo de la que sale el pago (cashBoxId)',
      );
    }
    return null;
  }

  /**
   * El medio con que se paga desde una caja: efectivo, transferencia (banco) o
   * Mercado Pago (billetera). Para los pagos que admiten más de una clase de caja.
   */
  async medioDeLaCaja(
    manager: EntityManager,
    distributorId: string,
    cashBoxId: string,
  ): Promise<CashMethod> {
    const filas: Array<{ kind: CashBoxKind }> = await manager.query(
      `SELECT "kind" FROM "cash_box"
       WHERE "cash_box_id" = $1 AND "distributor_id" = $2 AND "deletedAt" IS NULL`,
      [cashBoxId, distributorId],
    );
    if (!filas[0]) throw new CajaNoEncontradaError(cashBoxId);
    if (filas[0].kind === CashBoxKind.BANK) return CashMethod.TRANSFER;
    if (filas[0].kind === CashBoxKind.WALLET) return CashMethod.MERCADOPAGO;
    return CashMethod.CASH;
  }

  /** Salida del dinero del documento; 409 si la caja no tiene sesión abierta o saldo. */
  async egresar(
    manager: EntityManager,
    egreso: EgresoDeDocumento,
  ): Promise<CashMovement> {
    const categoria = await this.categorias.deSistema(
      manager,
      egreso.distributorId,
      egreso.systemCode,
    );
    return this.ledger.registrar(manager, {
      distributorId: egreso.distributorId,
      cashBoxId: egreso.cashBoxId,
      direction: CashDirection.OUT,
      amount: egreso.amount,
      categoryId: categoria.categoryId,
      method: egreso.method ?? CashMethod.CASH,
      description: egreso.description.slice(0, 255),
      referenceType: egreso.referenceType,
      referenceId: egreso.referenceId,
      userId: egreso.userId,
    });
  }

  /**
   * Contraasiento del egreso (el documento se corrige): misma caja, categoría e
   * importe, sentido opuesto. Se hace una sola vez por movimiento.
   */
  async revertir(
    manager: EntityManager,
    movementId: string,
    distributorId: string,
    motivo: string,
    userId: string,
  ): Promise<CashMovement | null> {
    const original = await manager.findOne(CashMovement, {
      where: { movementId, distributorId },
    });
    if (!original) throw new MovimientoNoEncontradoError(movementId);
    await this.ledger.bloquearCajas(
      manager,
      [original.cashBoxId],
      distributorId,
    );
    const yaAnulado = await manager.exists(CashMovement, {
      where: { reversesMovementId: movementId },
    });
    if (yaAnulado) return null;
    return this.ledger.registrar(manager, {
      distributorId,
      cashBoxId: original.cashBoxId,
      direction: sentidoOpuesto(original.direction),
      amount: original.amount,
      categoryId: original.categoryId,
      method: original.method,
      description: `Anulación: ${motivo}`.slice(0, 255),
      referenceType: CashReferenceType.REVERSAL,
      referenceId: original.movementId,
      reversesMovementId: original.movementId,
      userId,
      esContraasiento: true,
    });
  }
}
