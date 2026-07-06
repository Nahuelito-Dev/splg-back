import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';

/** Ítem mínimo necesario para mover stock (garrafa + cantidad). */
export interface StockMovementItem {
  gas_cylinder_id: string;
  quantity: number;
}

/**
 * Lógica de reserva/restitución de stock de garrafas.
 *
 * NO es un "port": a diferencia de RealtimeDispatchPort u OrderRepositoryPort,
 * esta operación DEBE participar de la unidad de trabajo (transacción) del
 * caller — reservar stock y persistir el pedido tienen que ser atómicos. Por eso
 * recibe el `EntityManager` de la transacción abierta por el use-case en vez de
 * abrir la suya. Centraliza el patrón "lock pesimista + ajustar stock" que antes
 * estaba duplicado en create (reserva) y cancel (restitución).
 */
@Injectable()
export class StockReservationService {
  /**
   * Reserva (descuenta) `quantity` de UNA garrafa dentro de la transacción del
   * caller. Toma un lock pesimista (SELECT ... FOR UPDATE) que serializa la
   * lectura con cualquier otra transacción sobre la misma garrafa → evita
   * oversell. Devuelve la garrafa bloqueada (para que el caller lea precio/promos).
   *
   * @throws NotFoundException si la garrafa no existe.
   * @throws BadRequestException si no hay stock suficiente.
   */
  async reserve(
    manager: EntityManager,
    gasCylinderId: string,
    quantity: number,
  ): Promise<GasCylinder> {
    const gasCylinder = await manager
      .createQueryBuilder(GasCylinder, 'gc')
      .setLock('pessimistic_write')
      .where('gc.gas_cylinder_id = :id', { id: gasCylinderId })
      .getOne();

    if (!gasCylinder) {
      throw new NotFoundException(`Garrafa no encontrada: ${gasCylinderId}`);
    }

    if (gasCylinder.stock < quantity) {
      throw new BadRequestException(
        `Stock insuficiente para ${gasCylinder.type}`,
      );
    }

    gasCylinder.stock -= quantity;
    await manager.save(gasCylinder);
    return gasCylinder;
  }

  /**
   * Restituye el stock de los ítems de un pedido cancelado, con lock pesimista
   * por garrafa (previene que una creación concurrente lea stock obsoleto
   * mientras devolvemos). Ítems de garrafa inexistente se ignoran silenciosamente
   * (la garrafa pudo darse de baja; el pedido igual se cancela).
   */
  async restore(
    manager: EntityManager,
    items: StockMovementItem[],
  ): Promise<void> {
    for (const item of items) {
      const cylinder = await manager
        .createQueryBuilder(GasCylinder, 'gc')
        .setLock('pessimistic_write')
        .where('gc.gas_cylinder_id = :id', { id: item.gas_cylinder_id })
        .getOne();

      if (cylinder) {
        cylinder.stock += item.quantity;
        await manager.save(cylinder);
      }
    }
  }
}
