import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CylinderLifecyclePort } from '../domain/ports/cylinder-lifecycle.port';
import { DeliverOrderCylindersUseCase } from '../../cylinder/application/deliver-order-cylinders.use-case';

/**
 * Adapter del puerto CylinderLifecyclePort: implementa el "el pedido se
 * entregó" con el caso de uso de envases `DeliverOrderCylindersUseCase` (lo
 * exporta CylinderModule, importado por OrderModule). El pedido no conoce las
 * tablas ni las reglas de los envases, y el `manager` de su transacción viaja
 * como la transacción en curso del caso de uso.
 */
@Injectable()
export class CylinderLifecycleAdapter extends CylinderLifecyclePort {
  constructor(private readonly entregar: DeliverOrderCylindersUseCase) {
    super();
  }

  onOrderDelivered(
    orderId: string,
    distributorId?: string | null,
    manager?: EntityManager,
  ): Promise<number> {
    return this.entregar.execute(orderId, distributorId, manager);
  }
}
