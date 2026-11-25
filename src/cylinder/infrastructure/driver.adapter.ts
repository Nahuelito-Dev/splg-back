import { Injectable } from '@nestjs/common';
import { DeliveryService } from '../../delivery/delivery.service';
import { DriverPort } from '../domain/ports/driver.port';

/** Adaptador: el perfil de chofer lo resuelve el módulo de choferes. */
@Injectable()
export class DriverAdapter extends DriverPort {
  constructor(private readonly deliveries: DeliveryService) {
    super();
  }

  async deliveryIdDe(userId: string): Promise<string | null> {
    const chofer = await this.deliveries.buscarPorIdOUsuario(userId);
    return chofer?.deliveryId ?? null;
  }
}
