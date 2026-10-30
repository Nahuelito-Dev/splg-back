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
import { CashCategoryService } from '../../cash/application/cash-category.service';
import { CashLedgerService } from '../../cash/application/cash-ledger.service';
import {
  ResultadoDelAsiento,
  SalesCashService,
} from '../../cash/application/sales-cash.service';
import {
  CashDirection,
  CashMethod,
  CashReferenceType,
  CashSystemCode,
} from '../../cash/domain/cash.enums';
import { CashBox } from '../../cash/entities/cash-box.entity';
import { CashCollectionSettings } from '../../cash/entities/cash-collection-settings.entity';
import { RoleType } from '../../common/constants/role-type.enum';
import { errorMessage } from '../../common/errors/error-message';
import { mensajeSeguro } from './mensaje-seguro';
import { diaArgentino } from '../../common/utils/dias-argentina';
import {
  MpDifferenceKind,
  MpItemStatus,
  MpReconciliationStatus,
} from '../domain/mp-reconciliation.enums';
import {
  ApplyMpReconciliationDto,
  MpApplyItemResultDto,
  MpApplyOutcome,
  MpApplyResponseDto,
} from '../dto/mp-reconciliation.dto';
import { MpReconciliationItem } from '../entities/mp-reconciliation-item.entity';
import { MpReconciliation } from '../entities/mp-reconciliation.entity';
import type { MpContexto } from './mp-reconciliation.service';

/** Lo que dejó un ajuste al asentarse. */
interface Asentado {
  /** Movimiento principal que quedó en la caja; `null` si lo había dejado otro flujo. */
  movementId: string | null;
  /** Otro flujo ya lo había asentado: no se repite. */
  yaEstaba: boolean;
}

/**
 * Asienta las diferencias que el administrador eligió de una conciliación. Cada
 * una va en su propia transacción: una que la caja rechaza no frena a las otras.
 * Nada se asienta dos veces: el ajuste queda marcado con la clave de la fila del
 * reporte (índice único) y las cobros/comisiones usan las mismas referencias
 * que el resto del sistema.
 */
@Injectable()
export class MpReconciliationApplyService {
  private readonly logger = new Logger(MpReconciliationApplyService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: CashLedgerService,
    private readonly categorias: CashCategoryService,
    private readonly ventas: SalesCashService,
  ) {}

  async aplicar(
    corridaId: string,
    dto: ApplyMpReconciliationDto,
    ctx: MpContexto,
  ): Promise<MpApplyResponseDto> {
    const corrida = await this.dataSource.manager.findOne(MpReconciliation, {
      where: { reconciliationId: corridaId, distributorId: ctx.distributorId },
    });
    if (!corrida) {
      throw new NotFoundException(`Conciliación ${corridaId} no encontrada`);
    }
    if (corrida.status !== MpReconciliationStatus.READY) {
      throw new ConflictException(
        'La conciliación todavía no tiene el reporte de Mercado Pago: esperá a que esté lista',
      );
    }
    const pedidos = new Map(dto.items.map((i) => [i.itemId, i.cashBoxId]));
    const items = await this.dataSource.manager.find(MpReconciliationItem, {
      where: [...pedidos.keys()].map((itemId) => ({
        itemId,
        reconciliationId: corridaId,
        distributorId: ctx.distributorId,
      })),
    });
    const hallados = new Map(items.map((i) => [i.itemId, i]));
    for (const itemId of pedidos.keys()) {
      const item = hallados.get(itemId);
      if (!item || (item.accountLevel && ctx.role !== RoleType.SUPER_ADMIN)) {
        throw new NotFoundException(`Diferencia ${itemId} no encontrada`);
      }
      if (!item.appliable) {
        throw new BadRequestException(
          `La diferencia ${itemId} (${item.kind}) no se puede asentar desde acá: ${item.note}`,
        );
      }
      if (item.needsCashBox && !pedidos.get(itemId)) {
        throw new BadRequestException(
          'Los retiros piden la caja de destino (`cashBoxId`)',
        );
      }
    }
    if (items.some((i) => i.accountLevel)) {
      if (!dto.distributorId) {
        throw new BadRequestException(
          'Las diferencias de la cuenta piden la distribuidora destino (`distributorId`)',
        );
      }
      if (dto.distributorId !== corrida.distributorId) {
        throw new BadRequestException(
          '`distributorId` tiene que ser la distribuidora de la conciliación',
        );
      }
    }
    const config = await this.dataSource.manager.findOne(
      CashCollectionSettings,
      { where: { distributorId: ctx.distributorId } },
    );
    if (!config?.mercadoPagoCashBoxId) {
      throw new ConflictException(
        'Elegí primero la caja de Mercado Pago en la configuración de cajas de cobro',
      );
    }
    const cajaMp = config.mercadoPagoCashBoxId;

    const resultados: MpApplyItemResultDto[] = [];
    for (const item of items) {
      resultados.push(
        await this.aplicarUna(item, pedidos.get(item.itemId), cajaMp, ctx),
      );
    }
    const respuesta = new MpApplyResponseDto();
    respuesta.results = resultados;
    respuesta.applied = resultados.filter(
      (r) => r.outcome === 'applied',
    ).length;
    respuesta.alreadyApplied = resultados.filter(
      (r) => r.outcome === 'already_applied',
    ).length;
    respuesta.failed = resultados.filter((r) => r.outcome === 'failed').length;
    return respuesta;
  }

  private async aplicarUna(
    item: MpReconciliationItem,
    cajaDestino: string | undefined,
    cajaMp: string,
    ctx: MpContexto,
  ): Promise<MpApplyItemResultDto> {
    const resultado = (
      outcome: MpApplyOutcome,
      message: string | null,
      movementId: string | null = null,
    ): MpApplyItemResultDto => {
      const r = new MpApplyItemResultDto();
      r.itemId = item.itemId;
      r.outcome = outcome;
      r.message = message;
      r.movementId = movementId;
      return r;
    };
    try {
      return await this.dataSource.transaction(async (manager) => {
        const actual = await manager.findOne(MpReconciliationItem, {
          where: { itemId: item.itemId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!actual) throw new NotFoundException('Diferencia no encontrada');
        if (actual.status === MpItemStatus.APPLIED) {
          return resultado(
            'already_applied',
            'Ya estaba asentada',
            actual.appliedMovementId,
          );
        }
        const otraCorrida = await manager.exists(MpReconciliationItem, {
          where: actual.accountLevel
            ? {
                rowKey: actual.rowKey,
                accountLevel: true,
                status: MpItemStatus.APPLIED,
              }
            : {
                distributorId: actual.distributorId,
                rowKey: actual.rowKey,
                status: MpItemStatus.APPLIED,
              },
        });
        if (otraCorrida) {
          return resultado(
            'already_applied',
            'Esa fila del reporte ya se asentó desde otra conciliación',
          );
        }
        const asentado = await this.asentar(
          manager,
          actual,
          cajaMp,
          cajaDestino,
          ctx,
        );
        actual.status = MpItemStatus.APPLIED;
        actual.appliedAt = new Date();
        actual.appliedByUserId = ctx.userId;
        actual.appliedMovementId = asentado.movementId;
        actual.targetCashBoxId = cajaDestino ?? null;
        await manager.save(actual);
        return resultado(
          asentado.yaEstaba ? 'already_applied' : 'applied',
          asentado.yaEstaba
            ? 'Otro proceso ya lo había asentado en la caja'
            : null,
          asentado.movementId,
        );
      });
    } catch (error) {
      this.logger.warn(
        `Conciliación ${item.reconciliationId}: no se asentó ${item.kind} ${item.itemId}: ${errorMessage(error)}`,
      );
      return resultado('failed', mensajeSeguro(error));
    }
  }

  private async asentar(
    manager: EntityManager,
    item: MpReconciliationItem,
    cajaMp: string,
    cajaDestino: string | undefined,
    ctx: MpContexto,
  ): Promise<Asentado> {
    if (item.paymentId) {
      await manager.query(
        `SELECT 1 FROM "payment" WHERE "payment_id" = $1 AND "distributor_id" = $2 FOR UPDATE`,
        [item.paymentId, item.distributorId],
      );
    }
    switch (item.kind) {
      case MpDifferenceKind.PAYMENT_NOT_IN_CASH:
        return this.asentarCobro(manager, item, ctx);
      case MpDifferenceKind.FEE_PENDING:
        return this.asentarComisionPendiente(manager, item, ctx);
      case MpDifferenceKind.FEE_MISMATCH:
        return this.ajuste(manager, item, ctx, {
          cajaPorOmision: cajaMp,
          direction: item.direction ?? CashDirection.OUT,
          categoria:
            item.direction === CashDirection.IN
              ? CashSystemCode.MERCADOPAGO_FEE_REFUND
              : CashSystemCode.MERCADOPAGO_FEE,
          importe: new Decimal(item.difference ?? 0).abs(),
        });
      case MpDifferenceKind.TAX_WITHHOLDING:
        return this.ajuste(manager, item, ctx, {
          cajaPorOmision: cajaMp,
          direction: CashDirection.OUT,
          categoria: CashSystemCode.TAXES_WITHHOLDINGS,
          importe: new Decimal(item.mpAmount ?? 0),
        });
      case MpDifferenceKind.TAX_ROW:
        return this.ajuste(manager, item, ctx, {
          cajaPorOmision: cajaMp,
          direction: item.direction ?? CashDirection.OUT,
          categoria:
            item.direction === CashDirection.IN
              ? CashSystemCode.MERCADOPAGO_FEE_REFUND
              : CashSystemCode.TAXES_WITHHOLDINGS,
          importe: new Decimal(item.mpAmount ?? 0),
        });
      case MpDifferenceKind.TAX_REFUND:
      case MpDifferenceKind.FEE_REIMBURSEMENT:
        return this.ajuste(manager, item, ctx, {
          cajaPorOmision: cajaMp,
          direction: CashDirection.IN,
          categoria: CashSystemCode.MERCADOPAGO_FEE_REFUND,
          importe: new Decimal(item.mpAmount ?? 0),
        });
      case MpDifferenceKind.REFUND_MISSING:
        return this.asentarDevolucion(manager, item, cajaMp, ctx);
      case MpDifferenceKind.PAYOUT:
        return this.asentarRetiro(manager, item, cajaMp, cajaDestino, ctx);
      default:
        throw new BadRequestException(
          `La diferencia de tipo ${item.kind} no se asienta desde acá`,
        );
    }
  }

  private descripcion(item: MpReconciliationItem): string {
    const dia = diaArgentino(item.occurredAt ?? new Date());
    const origen = item.sourceId ? ` (${item.sourceId})` : '';
    return `Conciliación MP ${dia} — ${item.mpDescription}${origen}`.slice(
      0,
      255,
    );
  }

  /** Cobro de Mercado Pago sin ingreso: el mismo asiento que `settle-pending`, con el bruto y la comisión del reporte. */
  private async asentarCobro(
    manager: EntityManager,
    item: MpReconciliationItem,
    ctx: MpContexto,
  ): Promise<Asentado> {
    if (!item.paymentId || !item.orderId || !item.sourceId) {
      throw new BadRequestException('La diferencia no tiene el cobro asociado');
    }
    const resultado = await this.ventas.asentarCobroDeMercadoPago(manager, {
      distributorId: item.distributorId,
      orderId: item.orderId,
      paymentId: item.paymentId,
      gatewayPaymentId: item.sourceId,
      amount: item.mpAmount ?? 0,
      feeAmount: item.extraAmount,
      feeUnreported: false,
      userId: ctx.userId,
    });
    this.exigirAsiento(resultado);
    if (resultado === 'asentado' && item.extraAmount) {
      await this.marcarComisionInformada(
        manager,
        item.paymentId,
        item.extraAmount,
      );
    }
    return {
      movementId: await this.movimientoDe(
        manager,
        CashReferenceType.PAYMENT,
        item.paymentId,
      ),
      yaEstaba: resultado === 'ya_asentado',
    };
  }

  private async asentarComisionPendiente(
    manager: EntityManager,
    item: MpReconciliationItem,
    ctx: MpContexto,
  ): Promise<Asentado> {
    if (!item.paymentId || !item.orderId || !item.sourceId) {
      throw new BadRequestException('La diferencia no tiene el cobro asociado');
    }
    const resultado = await this.ventas.asentarComision(manager, {
      distributorId: item.distributorId,
      orderId: item.orderId,
      paymentId: item.paymentId,
      gatewayPaymentId: item.sourceId,
      feeAmount: item.mpAmount ?? 0,
      userId: ctx.userId,
    });
    this.exigirAsiento(resultado);
    if (resultado === 'asentado') {
      await this.marcarComisionInformada(
        manager,
        item.paymentId,
        item.mpAmount ?? 0,
      );
    }
    return {
      movementId: await this.movimientoDe(
        manager,
        CashReferenceType.PAYMENT_FEE,
        item.paymentId,
      ),
      yaEstaba: resultado === 'ya_asentado',
    };
  }

  private exigirAsiento(resultado: ResultadoDelAsiento): void {
    if (resultado === 'asentado' || resultado === 'ya_asentado') return;
    const motivo: Record<string, string> = {
      sin_caja: 'La distribuidora no tiene configurada la caja de Mercado Pago',
      fallo:
        'La caja rechazó el movimiento (¿está desactivada o sin sesión abierta?)',
      sin_efecto: 'No hay nada que asentar para este cobro',
    };
    throw new ConflictException(motivo[resultado] ?? 'No se pudo asentar');
  }

  private async marcarComisionInformada(
    manager: EntityManager,
    paymentId: string,
    fee: Decimal.Value,
  ): Promise<void> {
    await manager.query(
      `UPDATE "payment" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || $2::jsonb WHERE "payment_id" = $1`,
      [
        paymentId,
        JSON.stringify({
          feeAmount: new Decimal(fee).toNumber(),
          feeStatus: 'reported',
        }),
      ],
    );
  }

  private async movimientoDe(
    manager: EntityManager,
    tipo: CashReferenceType,
    referenceId: string,
  ): Promise<string | null> {
    const filas: Array<{ movement_id: string }> = await manager.query(
      `SELECT "movement_id" FROM "cash_movement" WHERE "reference_type" = $1 AND "reference_id" = $2 LIMIT 1`,
      [tipo, referenceId],
    );
    return filas[0]?.movement_id ?? null;
  }

  /** La caja donde entró el cobro; sin cobro, la de Mercado Pago. */
  private async cajaDelCobro(
    manager: EntityManager,
    item: MpReconciliationItem,
    cajaPorOmision: string,
  ): Promise<string> {
    if (!item.paymentId) return cajaPorOmision;
    const filas: Array<{ cash_box_id: string }> = await manager.query(
      `SELECT "cash_box_id" FROM "cash_movement" WHERE "reference_type" = 'payment' AND "reference_id" = $1 LIMIT 1`,
      [item.paymentId],
    );
    return filas[0]?.cash_box_id ?? cajaPorOmision;
  }

  /** Un movimiento suelto del ajuste, con la referencia de la diferencia. */
  private async ajuste(
    manager: EntityManager,
    item: MpReconciliationItem,
    ctx: MpContexto,
    a: {
      cajaPorOmision: string;
      direction: CashDirection;
      categoria: CashSystemCode;
      importe: Decimal;
    },
  ): Promise<Asentado> {
    if (a.importe.lte(0)) {
      throw new ConflictException('El importe del ajuste es cero');
    }
    const categoria = await this.categorias.deSistema(
      manager,
      item.distributorId,
      a.categoria,
    );
    const movimiento = await this.ledger.registrar(manager, {
      distributorId: item.distributorId,
      cashBoxId: await this.cajaDelCobro(manager, item, a.cajaPorOmision),
      direction: a.direction,
      amount: a.importe,
      categoryId: categoria.categoryId,
      method: CashMethod.MERCADOPAGO,
      description: this.descripcion(item),
      referenceType: CashReferenceType.MP_RECONCILIATION,
      referenceId: item.itemId,
      userId: ctx.userId,
    });
    return { movementId: movimiento.movementId, yaEstaba: false };
  }

  /** Devolución o contracargo sin egreso: sale de la caja del cobro, sin pasar de lo que ingresó. */
  private async asentarDevolucion(
    manager: EntityManager,
    item: MpReconciliationItem,
    cajaMp: string,
    ctx: MpContexto,
  ): Promise<Asentado> {
    if (!item.paymentId) {
      throw new BadRequestException('La diferencia no tiene el cobro asociado');
    }
    const [ingreso]: Array<{ cash_box_id: string; amount: string }> =
      await manager.query(
        `SELECT "cash_box_id", "amount" FROM "cash_movement" WHERE "reference_type" = 'payment' AND "reference_id" = $1`,
        [item.paymentId],
      );
    if (!ingreso) {
      throw new ConflictException(
        'El cobro todavía no entró a la caja: asentalo primero',
      );
    }
    const [egresado]: Array<{ total: string }> = await manager.query(
      `SELECT COALESCE(SUM(m."amount"), 0) AS total FROM "cash_movement" m
       WHERE m."direction" = 'out' AND (
         (m."reference_type" = 'payment_external_refund' AND m."reference_id" = $1)
         OR (m."reference_type" = 'payment_refund'
             AND m."reference_id" IN (SELECT "refund_id" FROM "payment_refund" WHERE "payment_id" = $1)))`,
      [item.paymentId],
    );
    const libre = new Decimal(ingreso.amount).minus(egresado?.total ?? 0);
    const importe = Decimal.min(new Decimal(item.mpAmount ?? 0), libre);
    if (importe.lte(0)) {
      throw new ConflictException(
        'La caja ya devolvió todo lo que ingresó este cobro',
      );
    }
    const categoria = await this.categorias.deSistema(
      manager,
      item.distributorId,
      CashSystemCode.CUSTOMER_REFUND,
    );
    const movimiento = await this.ledger.registrar(manager, {
      distributorId: item.distributorId,
      cashBoxId: ingreso.cash_box_id ?? cajaMp,
      direction: CashDirection.OUT,
      amount: importe,
      categoryId: categoria.categoryId,
      method: CashMethod.MERCADOPAGO,
      description: this.descripcion(item),
      referenceType: CashReferenceType.PAYMENT_EXTERNAL_REFUND,
      referenceId: item.paymentId,
      userId: ctx.userId,
    });
    return { movementId: movimiento.movementId, yaEstaba: false };
  }

  /** Retiro de la billetera: sale de la caja de Mercado Pago y entra a la caja elegida; la comisión del retiro sale aparte. */
  private async asentarRetiro(
    manager: EntityManager,
    item: MpReconciliationItem,
    cajaMp: string,
    cajaDestino: string | undefined,
    ctx: MpContexto,
  ): Promise<Asentado> {
    if (!cajaDestino) {
      throw new BadRequestException('Elegí la caja de destino del retiro');
    }
    if (cajaDestino === cajaMp) {
      throw new BadRequestException(
        'La caja de destino tiene que ser distinta de la de Mercado Pago',
      );
    }
    await this.ledger.bloquearCajas(
      manager,
      [cajaMp, cajaDestino],
      item.distributorId,
    );
    const destino = await manager.findOneByOrFail(CashBox, {
      cashBoxId: cajaDestino,
    });
    const origen = await manager.findOneByOrFail(CashBox, {
      cashBoxId: cajaMp,
    });
    const importe = new Decimal(item.mpAmount ?? 0);
    if (importe.lte(0))
      throw new ConflictException('El importe del retiro es cero');
    const [catSalida, catEntrada] = [
      await this.categorias.deSistema(
        manager,
        item.distributorId,
        CashSystemCode.TRANSFER_OUT,
      ),
      await this.categorias.deSistema(
        manager,
        item.distributorId,
        CashSystemCode.TRANSFER_IN,
      ),
    ];
    const descripcion = this.descripcion(item);
    const salida = await this.ledger.registrar(manager, {
      distributorId: item.distributorId,
      cashBoxId: origen.cashBoxId,
      direction: CashDirection.OUT,
      amount: importe,
      categoryId: catSalida.categoryId,
      method: CashMethod.MERCADOPAGO,
      description: `${descripcion} — a ${destino.name}`.slice(0, 255),
      referenceType: CashReferenceType.BOX_TRANSFER,
      userId: ctx.userId,
    });
    await this.ledger.registrar(manager, {
      distributorId: item.distributorId,
      cashBoxId: destino.cashBoxId,
      direction: CashDirection.IN,
      amount: importe,
      categoryId: catEntrada.categoryId,
      method: CashMethod.TRANSFER,
      description: `${descripcion} — desde ${origen.name}`.slice(0, 255),
      referenceType: CashReferenceType.BOX_TRANSFER,
      referenceId: salida.movementId,
      userId: ctx.userId,
    });
    if (item.extraAmount && item.extraAmount > 0) {
      const categoria = await this.categorias.deSistema(
        manager,
        item.distributorId,
        CashSystemCode.MERCADOPAGO_FEE,
      );
      await this.ledger.registrar(manager, {
        distributorId: item.distributorId,
        cashBoxId: origen.cashBoxId,
        direction: CashDirection.OUT,
        amount: item.extraAmount,
        categoryId: categoria.categoryId,
        method: CashMethod.MERCADOPAGO,
        description: `Comisión del retiro — ${descripcion}`.slice(0, 255),
        referenceType: CashReferenceType.MP_RECONCILIATION,
        referenceId: item.itemId,
        userId: ctx.userId,
      });
    }
    return { movementId: salida.movementId, yaEstaba: false };
  }
}
