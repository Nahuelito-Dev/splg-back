import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { instanteValido } from '../../cash/domain/instante-del-pago';
import { PayFromCashBoxDto } from '../../cash/dto/pay-expense.dto';
import { CashDocumentPaymentService } from '../../cash/application/cash-document-payment.service';
import {
  CashReferenceType,
  CashSystemCode,
} from '../../cash/domain/cash.enums';
import {
  CompraInvalidaError,
  RecepcionNoEncontradaError,
} from '../domain/errors/purchase.errors';
import { PaymentStatus, PurchaseReceiptStatus } from '../domain/purchase.enums';
import { PurchaseReceipt } from '../entities/purchase-receipt.entity';
import { SupplierDocumentType } from '../domain/purchase.enums';
import { PurchaseOrder } from '../entities/purchase-order.entity';
import { Supplier } from '../entities/supplier.entity';
import {
  assertDuenoSinCambios,
  dinero,
  esImporteIgual,
  ValoresDelDueno,
} from '../../common/utils/conciliacion-de-documentos';

export interface PagoDeRecepcion {
  paymentStatus: PaymentStatus;
  /** Se pagó en efectivo de una caja de la distribuidora. */
  paidInCash?: boolean;
  cashBoxId?: string;
}

/** Cambios del remito que no mueven stock. */
@Injectable()
export class PurchaseReceiptService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pagos: CashDocumentPaymentService,
  ) {}

  /**
   * Registra la factura leída en la recepción, dentro de la transacción de la
   * lectura. El total no se toca: se controla contra el mismo esperado y con la
   * misma tolerancia que la conciliación.
   */
  async registrarFacturaDesdeLectura(
    manager: EntityManager,
    id: string,
    distributorId: string,
    datos: {
      numero: string;
      total: string | null;
      tolerancePct: number;
      expected: ValoresDelDueno;
    },
  ): Promise<void> {
    const recepcion = await manager
      .getRepository(PurchaseReceipt)
      .createQueryBuilder('r')
      .setLock('pessimistic_write')
      .where('r.receiptId = :id AND r.distributorId = :distributorId', {
        id,
        distributorId,
      })
      .getOne();
    if (!recepcion) throw new RecepcionNoEncontradaError(id);
    if (recepcion.status === PurchaseReceiptStatus.VOIDED) {
      throw new ConflictException(
        'La recepción está anulada: no se le registra la factura',
      );
    }
    const orden = recepcion.purchaseOrderId
      ? await manager.findOne(PurchaseOrder, {
          where: { purchaseOrderId: recepcion.purchaseOrderId, distributorId },
          withDeleted: true,
          lock: { mode: 'pessimistic_read' },
        })
      : null;
    const proveedor = await manager.findOne(Supplier, {
      where: { supplierId: recepcion.supplierId, distributorId },
      withDeleted: true,
      lock: { mode: 'pessimistic_read' },
    });
    const esperado = dinero(
      recepcion.totalAmount || orden?.totalAmount || null,
    );
    assertDuenoSinCambios(datos.expected, {
      cuit_del_emisor: proveedor?.cuit ?? null,
      total: esperado,
    });
    if (!esImporteIgual(esperado, datos.total, datos.tolerancePct)) {
      throw new BadRequestException(
        'Total: el importe de la factura no coincide con el de la recepción',
      );
    }
    if (recepcion.supplierDocumentType === SupplierDocumentType.INVOICE) {
      if (recepcion.supplierDocumentNumber === datos.numero) return;
      throw new ConflictException(
        `La recepción ya tiene registrada la factura ${recepcion.supplierDocumentNumber}`,
      );
    }
    recepcion.supplierDocumentType = SupplierDocumentType.INVOICE;
    recepcion.supplierDocumentNumber = datos.numero;
    await manager.save(recepcion);
  }

  /**
   * Marca el remito como pagado o impago. Pagado en efectivo, el total sale de
   * la caja indicada en la MISMA transacción (categoría de sistema `purchase`,
   * origen `purchase_receipt`) y `cash_movement_id` guarda la salida. Marcarlo
   * impago asienta el contraasiento y lo deja en `null`. Repetir el estado
   * actual es un no-op: no asienta dos veces. Sin cajas de efectivo activas el
   * pago es sólo la marca.
   */
  async cambiarEstadoDePago(
    id: string,
    pago: PagoDeRecepcion,
    distributorId: string,
    actorUserId: string,
  ): Promise<string> {
    this.validarPedido(pago);
    await this.dataSource.transaction(async (manager) => {
      const recepcion = await manager
        .getRepository(PurchaseReceipt)
        .createQueryBuilder('r')
        .setLock('pessimistic_write')
        .where('r.receiptId = :id AND r.distributorId = :distributorId', {
          id,
          distributorId,
        })
        .getOne();
      if (!recepcion) throw new RecepcionNoEncontradaError(id);
      if (recepcion.status === PurchaseReceiptStatus.VOIDED) {
        throw new CompraInvalidaError(
          `La recepción N° ${recepcion.number} está anulada: no se le cambia el estado de pago`,
        );
      }
      if (
        pago.paymentStatus === PaymentStatus.PAID &&
        recepcion.paymentStatus === PaymentStatus.PAID &&
        pago.paidInCash &&
        !recepcion.cashMovementId
      ) {
        throw new ConflictException(
          `La recepción N° ${recepcion.number} ya figura como pagada sin salida de caja: marcala impaga y volvé a pagarla en efectivo`,
        );
      }
      if (recepcion.paymentStatus === pago.paymentStatus) return;

      if (pago.paymentStatus === PaymentStatus.PAID) {
        recepcion.cashMovementId = await this.egresoEnEfectivo(
          manager,
          recepcion,
          pago,
          distributorId,
          actorUserId,
        );
        recepcion.paidAt = new Date();
      } else if (recepcion.cashMovementId) {
        await this.pagos.revertir(
          manager,
          recepcion.cashMovementId,
          distributorId,
          `Pago de la recepción N° ${recepcion.number} dejado sin efecto`,
          actorUserId,
        );
        recepcion.cashMovementId = null;
      }
      if (pago.paymentStatus === PaymentStatus.UNPAID) recepcion.paidAt = null;
      recepcion.paymentStatus = pago.paymentStatus;
      await manager.save(recepcion);
    });
    return id;
  }

  /**
   * API v2: paga la recepción desde una caja de efectivo, banco o billetera,
   * con la fecha del pago. Una sola vez: pagada (con o sin salida de caja) es
   * 409; para corregirla se la marca impaga, que asienta el contraasiento.
   */
  async pagar(
    id: string,
    dto: PayFromCashBoxDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<string> {
    const pagadoEn = instanteValido(dto.paidAt, 'paidAt');
    await this.dataSource.transaction(async (manager) => {
      const recepcion = await manager
        .getRepository(PurchaseReceipt)
        .createQueryBuilder('r')
        .setLock('pessimistic_write')
        .where('r.receiptId = :id AND r.distributorId = :distributorId', {
          id,
          distributorId,
        })
        .getOne();
      if (!recepcion) throw new RecepcionNoEncontradaError(id);
      if (recepcion.status === PurchaseReceiptStatus.VOIDED) {
        throw new CompraInvalidaError(
          `La recepción N° ${recepcion.number} está anulada: no se paga`,
        );
      }
      if (recepcion.paymentStatus === PaymentStatus.PAID) {
        throw new ConflictException(
          `La recepción N° ${recepcion.number} ya está pagada`,
        );
      }
      if (diaArgentino(pagadoEn) < diaArgentino(recepcion.receivedAt)) {
        throw new CompraInvalidaError(
          'Fecha de pago: no puede ser anterior a la recepción de la compra',
        );
      }
      const total = new Decimal(recepcion.totalAmount);
      if (total.lte(0)) {
        throw new ConflictException(
          `La recepción N° ${recepcion.number} no tiene un importe para pagar`,
        );
      }
      const movimiento = await this.pagos.pagarDesdeUnaCaja(manager, {
        distributorId,
        cashBoxId: dto.cashBoxId,
        amount: total,
        systemCode: CashSystemCode.PURCHASE,
        referenceType: CashReferenceType.PURCHASE_RECEIPT,
        referenceId: recepcion.receiptId,
        description: `Pago de la recepción de compra N° ${recepcion.number}`,
        userId: actorUserId,
      });
      recepcion.cashMovementId = movimiento.movementId;
      recepcion.paidAt = pagadoEn;
      recepcion.paymentStatus = PaymentStatus.PAID;
      await manager.save(recepcion);
    });
    return id;
  }

  private validarPedido(pago: PagoDeRecepcion): void {
    if (pago.paymentStatus !== PaymentStatus.PAID && pago.paidInCash) {
      throw new CompraInvalidaError(
        'Pagado en efectivo: sólo se indica al marcar la recepción como pagada',
      );
    }
    if (pago.cashBoxId && !pago.paidInCash) {
      throw new CompraInvalidaError(
        'Caja: sólo se indica cuando el pago es en efectivo',
      );
    }
  }

  private async egresoEnEfectivo(
    manager: EntityManager,
    recepcion: PurchaseReceipt,
    pago: PagoDeRecepcion,
    distributorId: string,
    actorUserId: string,
  ): Promise<string | null> {
    if (!pago.paidInCash) return null;
    const cajaId = await this.pagos.cajaDelPago(
      manager,
      distributorId,
      pago.cashBoxId,
    );
    const total = new Decimal(recepcion.totalAmount);
    if (!cajaId || total.lte(0)) return null;
    const movimiento = await this.pagos.egresar(manager, {
      distributorId,
      cashBoxId: cajaId,
      amount: total,
      systemCode: CashSystemCode.PURCHASE,
      referenceType: CashReferenceType.PURCHASE_RECEIPT,
      referenceId: recepcion.receiptId,
      description: `Pago en efectivo de la recepción de compra N° ${recepcion.number}`,
      userId: actorUserId,
    });
    return movimiento.movementId;
  }
}
