import { Injectable } from '@nestjs/common';
import { CashBoxService } from '../../cash/application/cash-box.service';
import { CashMovementService } from '../../cash/application/cash-movement.service';
import { CommissionQueryService } from '../../commission/application/commission-query.service';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { aCentavos, sumar } from '../../common/utils/dinero';
import { CustomerAccountService } from '../../customer-account/application/customer-account.service';
import { DriverSettlementQueryService } from '../../driver-settlement/application/driver-settlement-query.service';
import { FinanceDashboardDto } from '../dto/finance.dto';

/**
 * Tablero financiero (CU-245): saldos por caja, movimientos y rendiciones del
 * día, deuda de clientes y comisiones por liquidar. Es de sólo lectura sobre los
 * saldos guardados: no recalcula los libros.
 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly cajas: CashBoxService,
    private readonly movimientos: CashMovementService,
    private readonly rendiciones: DriverSettlementQueryService,
    private readonly cuentas: CustomerAccountService,
    private readonly comisiones: CommissionQueryService,
  ) {}

  async dashboard(
    distributorId: string,
    fecha?: string,
  ): Promise<FinanceDashboardDto> {
    const date = fecha ?? diaArgentino();
    const [cashBoxes, movements, settlements, receivables, commissions] =
      await Promise.all([
        this.cajas.resumenParaTablero(distributorId),
        this.movimientos.totalesDelDia(distributorId, date),
        this.rendiciones.resumenDelDia(distributorId, date),
        this.cuentas.resumenDeDeuda(distributorId),
        this.comisiones.pendienteDeLiquidar(distributorId),
      ]);
    return {
      date,
      cashBoxes,
      totalBalance: aCentavos(sumar(cashBoxes.map((c) => c.balance))),
      movements,
      settlements,
      receivables,
      commissions: {
        pendingToLiquidate: commissions.amount,
        employees: commissions.employees,
      },
    };
  }
}
