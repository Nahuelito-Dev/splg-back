import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  CompraInvalidaError,
  RecepcionNoEncontradaError,
} from '../domain/errors/purchase.errors';
import { PaymentStatus, PurchaseReceiptStatus } from '../domain/purchase.enums';
import { PurchaseReceipt } from '../entities/purchase-receipt.entity';

/** Cambios del remito que no mueven stock. */
@Injectable()
export class PurchaseReceiptService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Marca el remito como pagado o impago. La caja (M-D) todavía no existe:
   * `cash_movement_id` queda en `null` y el pago es sólo la marca.
   */
  async cambiarEstadoDePago(
    id: string,
    paymentStatus: PaymentStatus,
    distributorId: string,
  ): Promise<string> {
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
      recepcion.paymentStatus = paymentStatus;
      await manager.save(recepcion);
    });
    return id;
  }
}
