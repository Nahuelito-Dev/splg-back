import { Injectable } from '@nestjs/common';
import { CustomerContainerService } from '../../customer-container/customer-container.service';
import { ContainerAccountPort } from '../domain/ports/container-account.port';
import { Transaccion } from '../domain/ports/unit-of-work.port';
import { managerDe } from './typeorm-unit-of-work.adapter';

/** Adaptador: la cuenta de envases del cliente la lleva `customer-container`. */
@Injectable()
export class ContainerAccountAdapter extends ContainerAccountPort {
  constructor(private readonly cuentaDeEnvases: CustomerContainerService) {
    super();
  }

  async descontarPropioDevuelto(
    tx: Transaccion,
    datos: {
      distributorId: string;
      customerUserId: string;
      cylinderId: string;
      orderId: string | null;
    },
  ): Promise<void> {
    await this.cuentaDeEnvases.descontarPropioDevuelto(managerDe(tx), datos);
  }
}
