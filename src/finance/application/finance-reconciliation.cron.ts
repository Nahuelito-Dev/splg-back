import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CommissionLedgerService } from '../../commission/application/commission-ledger.service';
import { errorMessage } from '../../common/errors/error-message';
import { ZONA_ARGENTINA } from '../../common/utils/dias-argentina';
import { CustomerLedgerService } from '../../customer-account/application/customer-ledger.service';
import { RedisService } from '../../redis/redis.service';

/** Un saldo guardado que no es la suma de su libro (detalle del procedimiento). */
interface SaldoDesfasado {
  tipo: 'caja' | 'cuenta';
  id: string;
  saldo: string;
  libro: string;
}

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

  /**
   * Cuenta (y registra) las cajas y cuentas cuyo saldo no es la suma de su
   * libro. La verificación la hace el procedimiento `verificar_saldos_de_caja`,
   * una distribuidora por llamada.
   */
  async verificarSaldos(): Promise<number> {
    const distribuidoras: Array<{ distributor_id: string }> =
      await this.dataSource.query(
        `SELECT "distributor_id" FROM "cash_box"
         UNION SELECT "distributor_id" FROM "customer_account"`,
      );
    let desfasados = 0;
    for (const { distributor_id } of distribuidoras) {
      const [fila]: Array<{
        p_desfasadas: number;
        p_detalle: Array<SaldoDesfasado>;
      }> = await this.dataSource.query(
        `CALL verificar_saldos_de_caja($1, NULL::integer, NULL::jsonb)`,
        [distributor_id],
      );
      for (const d of fila?.p_detalle ?? []) {
        this.logger.warn(
          `${d.tipo === 'caja' ? 'Caja' : 'Cuenta corriente'} ${d.id}: saldo ${d.saldo} y el libro suma ${d.libro}`,
        );
      }
      desfasados += fila?.p_desfasadas ?? 0;
    }
    return desfasados;
  }
}
