import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import { traducirErrorDeBase } from '../../common/errors/db-exceptions';
import { aCentavos, dec } from '../../common/utils/dinero';
import { Customer } from '../../customer/entities/customer.entity';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { CustomerAccountStatus } from '../domain/customer-account.enums';
import { creditoDisponible } from '../domain/customer-account-rules';
import {
  ClienteNoEncontradoError,
  CuentaConflictoError,
  CuentaNoEncontradaError,
} from '../domain/errors/customer-account.errors';
import {
  CreateCustomerAccountDto,
  UpdateCustomerAccountDto,
} from '../dto/customer-account.dto';
import { CustomerAccount } from '../entities/customer-account.entity';

/** Pedidos a cuenta de un cliente que todavía no tienen su cargo asentado. */
export const SQL_PEDIDOS_A_CUENTA_ABIERTOS = `
  SELECT COALESCE(SUM(o."totalAmount"), 0)
  FROM "order" o
  WHERE o."distributor_id" = $1 AND o."customer_id" = $2
    AND o."paymentMethod" = 'account' AND o."status" <> 'cancelled'
    AND NOT EXISTS (
      SELECT 1 FROM "customer_account_entry" e
      WHERE e."order_id" = o."order_id" AND e."type" = 'sale_charge')`;

/** Alta, modificación y control de crédito de las cuentas corrientes (CU-235, 236, 331). */
@Injectable()
export class CustomerAccountService {
  private readonly logger = new Logger(CustomerAccountService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async habilitar(
    dto: CreateCustomerAccountDto,
    distributorId: string,
  ): Promise<CustomerAccount> {
    const cliente = await this.dataSource.manager.exists(Customer, {
      where: { userId: dto.customerUserId },
    });
    if (!cliente) throw new ClienteNoEncontradoError(dto.customerUserId);
    const vigente = await this.dataSource.manager.exists(CustomerAccount, {
      where: { distributorId, customerUserId: dto.customerUserId },
    });
    if (vigente) {
      throw new CuentaConflictoError(
        'El cliente ya tiene una cuenta corriente vigente en esta distribuidora',
      );
    }
    try {
      return await this.dataSource.manager.save(
        this.dataSource.manager.create(CustomerAccount, {
          distributorId,
          customerUserId: dto.customerUserId,
          businessName: dto.businessName,
          taxId: dto.taxId ?? null,
          taxCondition: dto.taxCondition,
          creditLimit: dto.creditLimit,
          paymentTermsDays: dto.paymentTermsDays,
          status: CustomerAccountStatus.ACTIVE,
          balance: 0,
        }),
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'cuentas corrientes');
    }
  }

  /**
   * Cambia términos y estado. Cerrar exige saldo cero y que no queden pedidos a
   * cuenta sin entregar (su cargo todavía va a llegar). Bajo lock de la cuenta:
   * no se cruza con un pago o un cargo en curso.
   */
  async modificar(
    id: string,
    dto: UpdateCustomerAccountDto,
    distributorId: string,
  ): Promise<CustomerAccount> {
    return this.dataSource.transaction(async (manager) => {
      const cuenta = await manager.findOne(CustomerAccount, {
        where: { accountId: id, distributorId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!cuenta) throw new CuentaNoEncontradaError(id);
      if (
        dto.status === CustomerAccountStatus.CLOSED &&
        cuenta.status !== CustomerAccountStatus.CLOSED
      ) {
        if (!dec(cuenta.balance).isZero()) {
          throw new CuentaConflictoError(
            `No se cierra una cuenta con saldo distinto de cero (saldo actual ${dec(cuenta.balance).toFixed(2)})`,
          );
        }
        const abiertos = await this.pedidosAbiertos(
          manager,
          distributorId,
          cuenta.customerUserId,
        );
        if (abiertos.gt(0)) {
          throw new CuentaConflictoError(
            'La cuenta tiene pedidos a cuenta sin entregar: esperá a que se entreguen o cancelalos',
          );
        }
      }
      if (dto.businessName !== undefined)
        cuenta.businessName = dto.businessName;
      if (dto.taxId !== undefined) cuenta.taxId = dto.taxId;
      if (dto.taxCondition !== undefined)
        cuenta.taxCondition = dto.taxCondition;
      if (dto.creditLimit !== undefined) cuenta.creditLimit = dto.creditLimit;
      if (dto.paymentTermsDays !== undefined) {
        cuenta.paymentTermsDays = dto.paymentTermsDays;
      }
      if (dto.status !== undefined) cuenta.status = dto.status;
      return manager.save(cuenta);
    });
  }

  /**
   * Verificación de crédito de una venta a cuenta (CU-236), dentro de la
   * transacción del pedido: bloquea la cuenta del cliente para que dos pedidos
   * simultáneos no superen el límite entre los dos. 409 si no hay cuenta, no
   * está activa o el total supera el disponible (con el disponible en el mensaje).
   */
  async assertCredito(
    manager: EntityManager,
    distributorId: string,
    customerId: string,
    total: Decimal.Value,
  ): Promise<void> {
    const [cuenta]: Array<{
      status: CustomerAccountStatus;
      credit_limit: string;
      balance: string;
    }> = await manager.query(
      `SELECT "status", "credit_limit", "balance" FROM "customer_account"
       WHERE "distributor_id" = $1 AND "customer_user_id" = $2 AND "deletedAt" IS NULL
       FOR UPDATE`,
      [distributorId, customerId],
    );
    if (!cuenta) {
      throw new CuentaConflictoError(
        'El cliente no tiene cuenta corriente en esta distribuidora',
      );
    }
    if (cuenta.status !== CustomerAccountStatus.ACTIVE) {
      throw new CuentaConflictoError(
        `La cuenta corriente del cliente está ${cuenta.status === CustomerAccountStatus.BLOCKED ? 'bloqueada' : 'cerrada'}`,
      );
    }
    const abiertos = await this.pedidosAbiertos(
      manager,
      distributorId,
      customerId,
    );
    const disponible = creditoDisponible(
      cuenta.credit_limit,
      cuenta.balance,
      abiertos,
    );
    if (dec(total).gt(disponible)) {
      throw new CuentaConflictoError(
        `El total ${dec(total).toFixed(2)} supera el crédito disponible del cliente (${disponible.toFixed(2)})`,
      );
    }
  }

  /** Para el tablero: deuda total, vencida y cuántas cuentas deben. */
  async resumenDeDeuda(distributorId: string): Promise<{
    totalDebt: number;
    overdueDebt: number;
    accountsWithDebt: number;
  }> {
    const [saldos]: Array<{ deuda: string; cuentas: number }> =
      await this.dataSource.query(
        `SELECT COALESCE(SUM("balance") FILTER (WHERE "balance" > 0), 0)::text AS deuda,
                COUNT(*) FILTER (WHERE "balance" > 0)::int AS cuentas
         FROM "customer_account"
         WHERE "distributor_id" = $1 AND "deletedAt" IS NULL`,
        [distributorId],
      );
    const [vencida]: Array<{ vencida: string }> = await this.dataSource.query(
      `SELECT COALESCE(SUM(e."amount" - COALESCE(a.aplicado, 0)), 0)::text AS vencida
       FROM "customer_account_entry" e
       LEFT JOIN LATERAL (
         SELECT SUM(al."amount") AS aplicado FROM "customer_account_allocation" al
         WHERE al."debit_entry_id" = e."entry_id") a ON true
       WHERE e."distributor_id" = $1 AND e."type" IN ('sale_charge', 'debit_note')
         AND e."due_date" < $2 AND e."amount" > COALESCE(a.aplicado, 0)`,
      [distributorId, diaArgentino()],
    );
    return {
      totalDebt: aCentavos(dec(saldos.deuda)),
      overdueDebt: aCentavos(dec(vencida.vencida)),
      accountsWithDebt: saldos.cuentas,
    };
  }

  async pedidosAbiertos(
    manager: EntityManager,
    distributorId: string,
    customerId: string,
  ): Promise<Decimal> {
    const [fila]: Array<{ coalesce: string }> = await manager.query(
      SQL_PEDIDOS_A_CUENTA_ABIERTOS,
      [distributorId, customerId],
    );
    return dec(fila.coalesce);
  }
}
