import { Injectable } from '@nestjs/common';
import { esAdministrador } from '../../common/utils/alcance.util';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { DeliveryService } from '../../delivery/delivery.service';

/**
 * Qué cargas puede ver y tocar quien pide: el administrador, todas las de su
 * distribuidora; el chofer, sólo las suyas.
 */
@Injectable()
export class TruckLoadAccessService {
  constructor(private readonly deliveries: DeliveryService) {}

  /**
   * `undefined` para un administrador; para un chofer, su `delivery_id`
   * (el alcance con el que se acota cada consulta).
   */
  async alcanceDe(user: AuthenticatedUser): Promise<string | undefined> {
    if (esAdministrador(user)) return undefined;
    return (await this.deliveries.findOneByUserId(user.user_id)).deliveryId;
  }
}
