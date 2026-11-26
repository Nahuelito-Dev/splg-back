import { Injectable } from '@nestjs/common';
import { CylinderState } from '../domain/cylinder-state';
import { ClockPort } from '../domain/ports/clock.port';
import { CylinderMovementRepositoryPort } from '../domain/ports/cylinder-movement.repository.port';
import { CylinderRepositoryPort } from '../domain/ports/cylinder.repository.port';
import { OrderDispatchPort } from '../domain/ports/order-dispatch.port';
import { Transaccion, UnitOfWorkPort } from '../domain/ports/unit-of-work.port';

/**
 * "El pedido se entregó": avanza todos los envases despachados en ese pedido
 * (DISPATCHED → WITH_CUSTOMER) y los deja a nombre del titular. Idempotente y
 * sin efecto si el pedido no tiene envases (las distribuidoras que no usan
 * envases físicos no se ven afectadas). Devuelve cuántos avanzó.
 */
@Injectable()
export class DeliverOrderCylindersUseCase {
  constructor(
    private readonly envases: CylinderRepositoryPort,
    private readonly movimientos: CylinderMovementRepositoryPort,
    private readonly pedidos: OrderDispatchPort,
    private readonly uow: UnitOfWorkPort,
    private readonly reloj: ClockPort,
  ) {}

  /**
   * Con `tx`, todas las lecturas y escrituras de envases van por ella: quien
   * llama tiene el pedido bloqueado en esa transacción, y escribir por otra
   * conexión quedaría esperando ese lock.
   */
  async execute(
    orderId: string,
    distributorId?: string | null,
    tx?: Transaccion,
  ): Promise<number> {
    if (!tx) {
      return this.uow.enTransaccion((propia) =>
        this.execute(orderId, distributorId, propia),
      );
    }
    // Se leen bloqueados: entre la lectura y el guardado alguien pudo
    // devolverlos al depósito o despacharlos a otro pedido.
    const despachados = await this.envases.bloquearDespachadosDelPedido(
      tx,
      orderId,
      distributorId,
    );
    if (despachados.length === 0) return 0;

    const pedido = await this.pedidos.titular(orderId, distributorId);
    const customerId = pedido?.customerId ?? null;
    const ahora = this.reloj.ahora();

    for (const envase of despachados) {
      const movimiento = envase.transicionar(
        CylinderState.WITH_CUSTOMER,
        {
          orderId,
          note: 'Entregado (auto al confirmar la entrega del pedido)',
          customerId,
        },
        ahora,
      );
      await this.envases.guardar(tx, envase);
      await this.movimientos.registrar(movimiento, tx);
    }
    return despachados.length;
  }
}
