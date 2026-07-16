import { Injectable } from '@nestjs/common';
import { CylinderLifecyclePort } from '../domain/ports/cylinder-lifecycle.port';
import { CylinderService } from '../../cylinder/cylinder.service';

/**
 * Adapter del puerto CylinderLifecyclePort: implementa el "el pedido se
 * entregó" delegando en CylinderService del módulo cylinder (importado por
 * OrderModule). Mantiene el dominio del pedido desacoplado del módulo de
 * envases.
 */
@Injectable()
export class CylinderLifecycleAdapter extends CylinderLifecyclePort {
  constructor(private readonly cylinders: CylinderService) {
    super();
  }

  onOrderDelivered(
    orderId: string,
    distributorId?: string | null,
  ): Promise<number> {
    return this.cylinders.onOrderDelivered(orderId, distributorId);
  }
}
