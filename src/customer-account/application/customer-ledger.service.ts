import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import { CashLedgerService } from '../../cash/application/cash-ledger.service';
import { CashCategoryService } from '../../cash/application/cash-category.service';
import {
  CashDirection,
  CashMethod,
  CashReferenceType,
  CashSystemCode,
} from '../../cash/domain/cash.enums';
import { errorMessage } from '../../common/errors/error-message';
import { deliveryIdDelUsuario } from '../../common/tenancy/chofer-empleado';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { aCentavos, dec } from '../../common/utils/dinero';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import { DriverSettlementService } from '../../driver-settlement/application/driver-settlement.service';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../order/entities/order.entity';
import { RoleType } from '../../common/constants/role-type.enum';
import {
  AdjustmentKind,
  CustomerAccountStatus,
  CustomerEntryType,
} from '../domain/customer-account.enums';
import {
  imputarFifo,
  saldoDespuesDelAsiento,
  signoDelAsiento,
  vencimientoDe,
} from '../domain/customer-account-rules';
import {
  CuentaConflictoError,
  CuentaInvalidaError,
  CuentaNoEncontradaError,
} from '../domain/errors/customer-account.errors';
import {
  RegisterAdjustmentDto,
  RegisterPaymentDto,
} from '../dto/customer-account.dto';
import { CustomerAccountAllocation } from '../entities/customer-account-allocation.entity';
import { CustomerAccountEntry } from '../entities/customer-account-entry.entity';
import { CustomerAccount } from '../entities/customer-account.entity';

export type ResultadoDelCargo =
  | 'asentado'
  | 'existente'
  | 'no-corresponde'
  | 'sin-cuenta';

const VENTANA_DEL_BARRIDO_DIAS = 7;

export interface Actor {
  userId: string;
  role: RoleType;
}

/** El asiento recién hecho con el saldo que dejó y lo que le queda por saldar. */
export interface AsientoAsentado {
  entry: CustomerAccountEntry;
  balanceAfter: number;
  /** En un cargo o nota de débito: lo que todavía no se saldó con pagos. */
  pendingAmount: number;
}

interface NuevoAsiento {
  type: CustomerEntryType;
  amount: Decimal.Value;
  orderId?: string | null;
  dueDate?: string | null;
  paymentMethod?: string | null;
  cashMovementId?: string | null;
  collectedByDeliveryId?: string | null;
  description?: string | null;
  occurredAt?: Date;
  createdByUserId?: string | null;
}

/**
 * Libro de la cuenta corriente: único lugar donde se asientan cargos, pagos y
 * ajustes. Toda escritura bloquea la cuenta (`FOR UPDATE`), inserta el asiento,
 * mueve el saldo e imputa los créditos a los cargos más viejos (FIFO).
 *
 * Orden de locks: la rendición del chofer y la caja van antes que la cuenta.
 */
@Injectable()
export class CustomerLedgerService {
  private readonly logger = new Logger(CustomerLedgerService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cashLedger: CashLedgerService,
    private readonly categorias: CashCategoryService,
    private readonly rendiciones: DriverSettlementService,
  ) {}

  /**
   * Pago de cuenta corriente (CU-237). El administrador lo asienta contra una
   * caja (entrada por el libro de caja). El chofer lo cobra en la calle: no
   * toca la caja, queda atado a su rendición abierta y entra a la caja cuando
   * el administrador la aprueba (una sola puerta para el dinero de la calle).
   */
  async registrarPago(
    accountId: string,
    dto: RegisterPaymentDto,
    distributorId: string,
    actor: Actor,
  ): Promise<AsientoAsentado> {
    const esChofer = actor.role === RoleType.DELIVERY;
    if (esChofer) {
      if (dto.cashBoxId) {
        throw new CuentaInvalidaError(
          'El chofer no elige la caja: el dinero entra a su rendición',
        );
      }
      if (dto.method !== CashMethod.CASH) {
        throw new CuentaInvalidaError(
          'El chofer sólo rinde efectivo: un pago por otro medio lo registra el administrador',
        );
      }
    }
    return withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          await this.existeCuenta(manager, accountId, distributorId);
          let cashMovementId: string | null = null;
          let deliveryId: string | null = null;
          let settlementId: string | null = null;
          if (esChofer) {
            deliveryId = await deliveryIdDelUsuario(
              manager,
              actor.userId,
              distributorId,
            );
            if (!deliveryId) throw new CuentaNoEncontradaError(accountId);
            settlementId = await this.rendiciones.bloquearAbiertaDelChofer(
              manager,
              distributorId,
              deliveryId,
            );
          } else {
            if (!dto.cashBoxId) {
              throw new CuentaConflictoError(
                'Indicá la caja donde entra el pago',
              );
            }
            const categoria = await this.categorias.deSistema(
              manager,
              distributorId,
              CashSystemCode.CUSTOMER_PAYMENT,
            );
            const movimiento = await this.cashLedger.registrar(manager, {
              distributorId,
              cashBoxId: dto.cashBoxId,
              direction: CashDirection.IN,
              amount: dto.amount,
              categoryId: categoria.categoryId,
              method: dto.method,
              description: (
                dto.description ?? 'Cobro de cuenta corriente'
              ).slice(0, 255),
              referenceType: CashReferenceType.CUSTOMER_PAYMENT,
              referenceId: accountId,
              userId: actor.userId,
            });
            cashMovementId = movimiento.movementId;
          }
          const cuenta = await this.bloquear(manager, accountId, distributorId);
          if (cuenta.status === CustomerAccountStatus.CLOSED) {
            throw new CuentaConflictoError('La cuenta está cerrada');
          }
          // Un cobro no puede ser mayor que la deuda: la base lo exige con
          // CHK_customer_account_entry_cobro_mayor_a_la_deuda.
          if (dec(dto.amount).gt(dec(cuenta.balance))) {
            throw new CuentaConflictoError(
              `El cobro ($${aCentavos(dec(dto.amount))}) supera la deuda de la cuenta ($${aCentavos(dec(cuenta.balance))}). Si el cliente pagó de más, registrá una nota de crédito por la diferencia`,
            );
          }
          const asiento = await this.asentar(manager, cuenta, {
            type: CustomerEntryType.PAYMENT,
            amount: dto.amount,
            paymentMethod: dto.method,
            cashMovementId,
            collectedByDeliveryId: deliveryId,
            description: dto.description ?? null,
            createdByUserId: actor.userId,
          });
          if (settlementId) {
            await this.rendiciones.vincularCobro(manager, {
              settlementId,
              entryId: asiento.entry.entryId,
              amount: dto.amount,
            });
          }
          return asiento;
        }),
      { context: 'CustomerLedgerService.registrarPago' },
    );
  }

  /** Nota de crédito (baja la deuda) o de débito (la sube), con su motivo (CU-329). */
  async registrarAjuste(
    accountId: string,
    dto: RegisterAdjustmentDto,
    distributorId: string,
    userId: string,
  ): Promise<AsientoAsentado> {
    return withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const cuenta = await this.bloquear(manager, accountId, distributorId);
          if (cuenta.status === CustomerAccountStatus.CLOSED) {
            throw new CuentaConflictoError('La cuenta está cerrada');
          }
          return this.asentar(manager, cuenta, {
            type:
              dto.kind === AdjustmentKind.CREDIT
                ? CustomerEntryType.CREDIT_NOTE
                : CustomerEntryType.DEBIT_NOTE,
            amount: dto.amount,
            description: dto.reason,
            createdByUserId: userId,
          });
        }),
      { context: 'CustomerLedgerService.registrarAjuste' },
    );
  }

  /**
   * Asienta el cargo de un pedido a cuenta ya entregado (CU-332), con
   * vencimiento a `plazo` días de la entrega. Idempotente: el cargo es único
   * por pedido. Un pedido que no es a cuenta o no está entregado no corresponde.
   */
  async asentarCargo(orderId: string): Promise<ResultadoDelCargo> {
    return this.dataSource.transaction(async (manager) => {
      const pedido = await manager.findOne(Order, { where: { orderId } });
      if (
        !pedido ||
        pedido.paymentMethod !== PaymentMethod.ACCOUNT ||
        pedido.status !== OrderStatus.DELIVERED ||
        !pedido.deliveredAt
      ) {
        return 'no-corresponde';
      }
      const [fila]: Array<{ account_id: string }> = await manager.query(
        `SELECT "account_id" FROM "customer_account"
         WHERE "distributor_id" = $1 AND "customer_user_id" = $2 AND "deletedAt" IS NULL`,
        [pedido.distributorId, pedido.customerId],
      );
      if (!fila) {
        this.logger.error(
          `Pedido ${orderId} a cuenta corriente: el cliente no tiene cuenta, no se asienta el cargo`,
        );
        return 'sin-cuenta';
      }
      const cuenta = await this.bloquear(
        manager,
        fila.account_id,
        pedido.distributorId,
      );
      const yaEsta = await manager.exists(CustomerAccountEntry, {
        where: { orderId, type: CustomerEntryType.SALE_CHARGE },
      });
      if (yaEsta) return 'existente';
      await this.asentar(manager, cuenta, {
        type: CustomerEntryType.SALE_CHARGE,
        amount: pedido.totalAmount,
        orderId,
        dueDate: vencimientoDe(
          diaArgentino(pedido.deliveredAt),
          cuenta.paymentTermsDays,
        ),
        description: `Venta a cuenta: pedido ${orderId.slice(0, 8)}`,
        occurredAt: pedido.deliveredAt,
        createdByUserId: null,
      });
      return 'asentado';
    });
  }

  /** Barrido nocturno de los pedidos a cuenta entregados que se quedaron sin cargo. */
  async barrer(): Promise<number> {
    const pendientes: Array<{ order_id: string }> = await this.dataSource.query(
      `SELECT o."order_id" FROM "order" o
       WHERE o."status" = 'delivered' AND o."paymentMethod" = 'account'
         AND o."deliveredAt" >= now() - make_interval(days => $1)
         AND NOT EXISTS (
           SELECT 1 FROM "customer_account_entry" e
           WHERE e."order_id" = o."order_id" AND e."type" = 'sale_charge')`,
      [VENTANA_DEL_BARRIDO_DIAS],
    );
    let asentados = 0;
    for (const { order_id } of pendientes) {
      try {
        if ((await this.asentarCargo(order_id)) === 'asentado') asentados += 1;
      } catch (error) {
        this.logger.error(
          `No se pudo asentar el cargo del pedido ${order_id}: ${errorMessage(error)}`,
        );
      }
    }
    return asentados;
  }

  /** Cuenta bloqueada `FOR UPDATE` (404 si no existe o es de otra distribuidora). */
  async bloquear(
    manager: EntityManager,
    accountId: string,
    distributorId: string,
  ): Promise<CustomerAccount> {
    const cuenta = await manager.findOne(CustomerAccount, {
      where: { accountId, distributorId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!cuenta) throw new CuentaNoEncontradaError(accountId);
    return cuenta;
  }

  private async existeCuenta(
    manager: EntityManager,
    accountId: string,
    distributorId: string,
  ): Promise<void> {
    const existe = await manager.exists(CustomerAccount, {
      where: { accountId, distributorId },
    });
    if (!existe) throw new CuentaNoEncontradaError(accountId);
  }

  /** Inserta el asiento, mueve el saldo e imputa. La cuenta ya viene bloqueada. */
  private async asentar(
    manager: EntityManager,
    cuenta: CustomerAccount,
    n: NuevoAsiento,
  ): Promise<AsientoAsentado> {
    const asiento = await manager.save(
      manager.create(CustomerAccountEntry, {
        distributorId: cuenta.distributorId,
        accountId: cuenta.accountId,
        type: n.type,
        amount: aCentavos(n.amount),
        orderId: n.orderId ?? null,
        dueDate: n.dueDate ?? null,
        paymentMethod: n.paymentMethod ?? null,
        cashMovementId: n.cashMovementId ?? null,
        collectedByDeliveryId: n.collectedByDeliveryId ?? null,
        description: n.description ?? null,
        occurredAt: n.occurredAt ?? new Date(),
        createdByUserId: n.createdByUserId ?? null,
      }),
    );
    const saldo = saldoDespuesDelAsiento(cuenta.balance, n.type, n.amount);
    await manager.query(
      `UPDATE "customer_account" SET "balance" = $1, "updatedAt" = now() WHERE "account_id" = $2`,
      [aCentavos(saldo), cuenta.accountId],
    );
    cuenta.balance = aCentavos(saldo);
    await this.imputar(manager, cuenta.accountId);
    const [fila]: Array<{ pendiente: string }> = await manager.query(
      `SELECT ($2::numeric - COALESCE(SUM("amount"), 0))::text AS pendiente
       FROM "customer_account_allocation" WHERE "debit_entry_id" = $1`,
      [asiento.entryId, asiento.amount],
    );
    const esCargo = signoDelAsiento(n.type) === 1;
    return {
      entry: asiento,
      balanceAfter: cuenta.balance,
      pendingAmount: esCargo ? aCentavos(dec(fila.pendiente)) : 0,
    };
  }

  /**
   * Imputación FIFO: aplica lo que falta de los pagos y notas de crédito a los
   * cargos y notas de débito más viejos. Recalcula desde el libro, así que es
   * idempotente.
   */
  private async imputar(
    manager: EntityManager,
    accountId: string,
  ): Promise<void> {
    const filas: Array<{
      entry_id: string;
      es_cargo: boolean;
      pendiente: string;
    }> = await manager.query(
      `SELECT e."entry_id",
                e."type" IN ('sale_charge', 'debit_note') AS es_cargo,
                e."amount" - COALESCE((
                  SELECT SUM(a."amount") FROM "customer_account_allocation" a
                  WHERE a."debit_entry_id" = e."entry_id" OR a."credit_entry_id" = e."entry_id"
                ), 0) AS pendiente
         FROM "customer_account_entry" e
         WHERE e."account_id" = $1
         ORDER BY e."occurred_at", e."createdAt", e."entry_id"`,
      [accountId],
    );
    const pendientes = filas
      .map((f) => ({
        entryId: f.entry_id,
        esCargo: f.es_cargo,
        pendiente: dec(f.pendiente),
      }))
      .filter((f) => f.pendiente.gt(0));
    const imputaciones = imputarFifo(
      pendientes.filter((f) => f.esCargo),
      pendientes.filter((f) => !f.esCargo),
    );
    for (const i of imputaciones) {
      await manager.save(
        manager.create(CustomerAccountAllocation, {
          accountId,
          debitEntryId: i.debitEntryId,
          creditEntryId: i.creditEntryId,
          amount: aCentavos(i.amount),
        }),
      );
    }
  }
}
