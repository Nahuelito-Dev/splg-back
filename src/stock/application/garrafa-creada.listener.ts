import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  EVENTO_GARRAFA_CREADA,
  GarrafaCreadaEvent,
} from '../../gascylinder/events/garrafa-creada.event';
import { StockLedgerPort } from '../domain/ports/stock-ledger.port';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../domain/stock.enums';
import { WarehouseService } from './warehouse.service';

/**
 * Un producto nuevo con stock vendible inicial: ese stock es físico lleno del
 * depósito predeterminado. El vendible ya está en `gas_cylinder.stock`
 * (`sin-cambio`); sólo falta el saldo y el movimiento `initial_count`.
 */
@Injectable()
export class GarrafaCreadaListener {
  private readonly logger = new Logger(GarrafaCreadaListener.name);

  constructor(
    private readonly ledger: StockLedgerPort,
    private readonly warehouses: WarehouseService,
  ) {}

  // `suppressErrors: false`: si falla, el error llega a `emitAsync` y deshace el
  // alta del producto (están en la misma transacción).
  @OnEvent(EVENTO_GARRAFA_CREADA, { suppressErrors: false })
  async handle(evento: GarrafaCreadaEvent): Promise<void> {
    if (evento.stock <= 0) return;
    const { locationId } = await this.warehouses.asegurarPredeterminado(
      evento.distributorId,
      evento.manager,
    );
    await this.ledger.aplicar(evento.manager, {
      distributorId: evento.distributorId,
      referenceType: StockReferenceType.INITIAL,
      referenceId: evento.gasCylinderId,
      actorUserId: null,
      vendible: 'sin-cambio',
      movimientos: [
        {
          gasCylinderId: evento.gasCylinderId,
          quantity: evento.stock,
          from: null,
          to: { locationId, condition: StockCondition.FULL },
          reason: StockMovementReason.INITIAL_COUNT,
        },
      ],
    });
    this.logger.log(
      `Stock inicial de ${evento.gasCylinderId} (${evento.stock}) registrado en el depósito predeterminado`,
    );
  }
}
