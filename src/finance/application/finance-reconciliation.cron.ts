import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CommissionLedgerService } from '../../commission/application/commission-ledger.service';
import { errorMessage } from '../../common/errors/error-message';
import { ZONA_ARGENTINA } from '../../common/utils/dias-argentina';
import { CustomerLedgerService } from '../../customer-account/application/customer-ledger.service';
import { RedisService } from '../../redis/redis.service';

/**
 * Conciliación nocturna de las finanzas (03:30): recupera los asientos de los
 * pedidos entregados que se quedaron sin comisión o sin cargo a cuenta (un
 * oyente que falló) y verifica que cada saldo guardado sea igual a la suma de
 * su libro. NO corrige un saldo desfasado: lo registra para que una persona lo
 * mire.
 */
@Injectable()
export class FinanceReconciliationCron {
  private readonly logger = new Logger(FinanceReconciliationCron.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly comisiones: CommissionLedgerService,
    private readonly cuentas: CustomerLedgerService,
    private readonly redis: RedisService,
  ) {}

  @Cron('30 3 * * *', { timeZone: ZONA_ARGENTINA })
  async conciliar(): Promise<void> {
    const lock = await this.redis.withLock(
      'cron:finance-reconciliation',
      10 * 60_000,
      () => this.correr(),
    );
    if (!lock.obtenido) {
      this.logger.log(
        'Conciliación financiera: la está corriendo otra instancia',
      );
    }
  }

  async correr(): Promise<{
    comisiones: number;
    cargos: number;
    saldosDesfasados: number;
  }> {
    let comisiones = 0;
    let cargos = 0;
    try {
      comisiones = await this.comisiones.barrer();
      cargos = await this.cuentas.barrer();
    } catch (error) {
      this.logger.error(`Falló el barrido de asientos: ${errorMessage(error)}`);
    }
    const saldosDesfasados = await this.verificarSaldos();
    this.logger.log(
      `Conciliación financiera: ${comisiones} comisión(es) y ${cargos} cargo(s) recuperados, ${saldosDesfasados} saldo(s) desfasado(s)`,
    );
    return { comisiones, cargos, saldosDesfasados };
  }

  /** Cuenta (y registra) las cajas y cuentas cuyo saldo no es la suma de su libro. */
  async verificarSaldos(): Promise<number> {
    const cajas: Array<{
      cash_box_id: string;
      balance: string;
      libro: string;
    }> = await this.dataSource.query(
      `SELECT b."cash_box_id", b."balance"::text,
                COALESCE(SUM(CASE WHEN m."direction" = 'in' THEN m."amount" ELSE -m."amount" END), 0)::text AS libro
         FROM "cash_box" b LEFT JOIN "cash_movement" m ON m."cash_box_id" = b."cash_box_id"
         GROUP BY b."cash_box_id", b."balance"
         HAVING b."balance" <> COALESCE(SUM(CASE WHEN m."direction" = 'in' THEN m."amount" ELSE -m."amount" END), 0)`,
    );
    const cuentas: Array<{
      account_id: string;
      balance: string;
      libro: string;
    }> = await this.dataSource.query(
      `SELECT a."account_id", a."balance"::text,
                COALESCE(SUM(CASE WHEN e."type" IN ('sale_charge', 'debit_note') THEN e."amount" ELSE -e."amount" END), 0)::text AS libro
         FROM "customer_account" a LEFT JOIN "customer_account_entry" e ON e."account_id" = a."account_id"
         GROUP BY a."account_id", a."balance"
         HAVING a."balance" <> COALESCE(SUM(CASE WHEN e."type" IN ('sale_charge', 'debit_note') THEN e."amount" ELSE -e."amount" END), 0)`,
    );
    for (const c of cajas) {
      this.logger.warn(
        `Caja ${c.cash_box_id}: saldo ${c.balance} y el libro suma ${c.libro}`,
      );
    }
    for (const c of cuentas) {
      this.logger.warn(
        `Cuenta corriente ${c.account_id}: saldo ${c.balance} y el libro suma ${c.libro}`,
      );
    }
    return cajas.length + cuentas.length;
  }
}
