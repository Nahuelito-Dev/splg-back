import { ConflictException, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { EntityManager } from 'typeorm';
import { aCentavos } from '../../common/utils/dinero';
import {
  CashDirection,
  CashMethod,
  CashReferenceType,
  CashSessionStatus,
} from '../domain/cash.enums';
import {
  categoriaCoincideConElSentido,
  dejaSaldoNegativoEnEfectivo,
  saldoDespuesDe,
} from '../domain/cash-rules';
import {
  CajaNoEncontradaError,
  CategoriaNoEncontradaError,
  MovimientoInvalidoError,
} from '../domain/errors/cash.errors';
import { CashBox } from '../entities/cash-box.entity';
import { CashCategory } from '../entities/cash-category.entity';
import { CashMovement } from '../entities/cash-movement.entity';
import { CashSession } from '../entities/cash-session.entity';

export interface RegistrarMovimiento {
  distributorId: string;
  cashBoxId: string;
  direction: CashDirection;
  amount: Decimal.Value;
  categoryId: string;
  method?: CashMethod;
  description: string;
  referenceType?: CashReferenceType;
  referenceId?: string | null;
  reversesMovementId?: string | null;
  /** Quién lo registra; `null` sólo en los orígenes que se asientan solos (lo exige un CHECK de la base). */
  userId: string | null;
  /**
   * Sólo la anulación y el ajuste de apertura: no exige sesión abierta (si hay
   * una, el movimiento se le asigna) ni que la categoría sea del mismo sentido
   * (la anulación usa la categoría del original en sentido contrario).
   */
  esContraasiento?: boolean;
  /** Sesión a la que se asigna: la que se está abriendo o cerrando. */
  sessionId?: string;
}

interface FilaCaja {
  cash_box_id: string;
  kind: CashBox['kind'];
  balance: string;
  requires_session: boolean;
  is_active: boolean;
}

/**
 * PUNTO ÚNICO por el que el dinero entra y sale de una caja. Bloquea la fila de
 * la caja (`FOR UPDATE`), valida sesión, categoría y saldo, inserta el
 * movimiento en el libro y actualiza `balance`, todo en la transacción de quien
 * llama (`manager`). La rendición del chofer, el cobro de cuenta corriente y el
 * pago de liquidaciones registran por acá en vez de escribir su propio asiento.
 *
 * Orden de locks: la caja va después del pedido, el chofer, el stock y la
 * rendición, y antes de la cuenta corriente y de la numeración de documentos.
 */
@Injectable()
export class CashLedgerService {
  /**
   * Bloquea varias cajas en un orden fijo (por id) para que dos
   * transferencias cruzadas no se interbloqueen. 404 si alguna no existe o es
   * de otra distribuidora.
   */
  async bloquearCajas(
    manager: EntityManager,
    ids: string[],
    distributorId: string,
  ): Promise<void> {
    const unicos = [...new Set(ids)].sort();
    const filas: Array<{ cash_box_id: string }> = await manager.query(
      `SELECT "cash_box_id" FROM "cash_box"
       WHERE "cash_box_id" = ANY($1::uuid[]) AND "distributor_id" = $2 AND "deletedAt" IS NULL
       ORDER BY "cash_box_id"
       FOR UPDATE`,
      [unicos, distributorId],
    );
    const halladas = new Set(filas.map((f) => f.cash_box_id));
    for (const id of unicos) {
      if (!halladas.has(id)) throw new CajaNoEncontradaError(id);
    }
  }

  async registrar(
    manager: EntityManager,
    entrada: RegistrarMovimiento,
  ): Promise<CashMovement> {
    const importe = new Decimal(entrada.amount);
    if (!importe.isFinite() || importe.lte(0)) {
      throw new MovimientoInvalidoError(
        'El importe tiene que ser mayor que cero',
      );
    }
    const [caja]: FilaCaja[] = await manager.query(
      `SELECT "cash_box_id", "kind", "balance", "requires_session", "is_active"
       FROM "cash_box"
       WHERE "cash_box_id" = $1 AND "distributor_id" = $2 AND "deletedAt" IS NULL
       FOR UPDATE`,
      [entrada.cashBoxId, entrada.distributorId],
    );
    if (!caja) throw new CajaNoEncontradaError(entrada.cashBoxId);
    if (!caja.is_active && !entrada.esContraasiento) {
      throw new ConflictException(
        'La caja está desactivada: activala para registrar movimientos',
      );
    }

    const categoria = await manager.findOne(CashCategory, {
      where: {
        categoryId: entrada.categoryId,
        distributorId: entrada.distributorId,
      },
    });
    if (!categoria) throw new CategoriaNoEncontradaError(entrada.categoryId);
    if (!entrada.esContraasiento && !categoria.isActive) {
      throw new MovimientoInvalidoError(
        `La categoría está desactivada: elegí otra (${categoria.name})`,
      );
    }
    if (
      !entrada.esContraasiento &&
      !categoriaCoincideConElSentido(entrada.direction, categoria.direction)
    ) {
      throw new MovimientoInvalidoError(
        entrada.direction === CashDirection.IN
          ? 'La categoría de una entrada tiene que ser de ingresos'
          : 'La categoría de una salida tiene que ser de gastos',
      );
    }

    const sesionId = await this.sesionDelMovimiento(manager, caja, entrada);

    const saldo = new Decimal(caja.balance);
    const resultante = saldoDespuesDe(saldo, entrada.direction, importe);
    if (dejaSaldoNegativoEnEfectivo(caja.kind, resultante)) {
      throw new ConflictException(
        `Saldo insuficiente en la caja: tiene ${saldo.toFixed(2)} y el movimiento sacaría ${importe.toFixed(2)}`,
      );
    }

    const movimiento = await manager.save(
      manager.create(CashMovement, {
        distributorId: entrada.distributorId,
        cashBoxId: entrada.cashBoxId,
        sessionId: sesionId,
        direction: entrada.direction,
        amount: aCentavos(importe),
        categoryId: entrada.categoryId,
        method: entrada.method ?? CashMethod.CASH,
        description: entrada.description,
        referenceType: entrada.referenceType ?? CashReferenceType.MANUAL,
        referenceId: entrada.referenceId ?? null,
        reversesMovementId: entrada.reversesMovementId ?? null,
        createdByUserId: entrada.userId,
      }),
    );
    await manager.query(
      `UPDATE "cash_box" SET "balance" = $1, "updatedAt" = now() WHERE "cash_box_id" = $2`,
      [aCentavos(resultante), entrada.cashBoxId],
    );
    return movimiento;
  }

  /** La sesión a la que va el movimiento; 409 si la caja la exige y no hay abierta. */
  private async sesionDelMovimiento(
    manager: EntityManager,
    caja: FilaCaja,
    entrada: RegistrarMovimiento,
  ): Promise<string | null> {
    if (entrada.sessionId) return entrada.sessionId;
    const abierta = await manager.findOne(CashSession, {
      where: {
        cashBoxId: caja.cash_box_id,
        status: CashSessionStatus.OPEN,
      },
    });
    if (caja.requires_session && !abierta && !entrada.esContraasiento) {
      throw new ConflictException(
        'La caja exige una sesión abierta: abrila antes de registrar movimientos',
      );
    }
    return abierta?.sessionId ?? null;
  }
}
