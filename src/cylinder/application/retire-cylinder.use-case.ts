import { Injectable, NotFoundException } from '@nestjs/common';
import { ClockPort } from '../domain/ports/clock.port';
import { CylinderMovementRepositoryPort } from '../domain/ports/cylinder-movement.repository.port';
import { CylinderRepositoryPort } from '../domain/ports/cylinder.repository.port';
import { Transaccion, UnitOfWorkPort } from '../domain/ports/unit-of-work.port';
import { conErroresHttp } from './domain-error.translator';

/** Baja de un envase (estado terminal). El registro no se borra: queda el motivo en el historial. */
@Injectable()
export class RetireCylinderUseCase {
  constructor(
    private readonly envases: CylinderRepositoryPort,
    private readonly movimientos: CylinderMovementRepositoryPort,
    private readonly uow: UnitOfWorkPort,
    private readonly reloj: ClockPort,
  ) {}

  /**
   * Baja común: sólo desde el depósito o devuelto vacío. Uno en poder de un
   * cliente se da por perdido con `porPerdida`.
   */
  execute(
    cylinderId: string,
    reason: string,
    distributorId: string,
    actorUserId?: string,
  ): Promise<void> {
    return conErroresHttp(() =>
      this.uow.enTransaccion(async (tx) => {
        const envase = await this.envases.bloquear(
          tx,
          cylinderId,
          distributorId,
        );
        if (!envase) throw new NotFoundException('Envase no encontrado');
        const movimiento = envase.darDeBaja(
          reason,
          actorUserId,
          this.reloj.ahora(),
        );
        await this.envases.guardar(tx, envase);
        await this.movimientos.registrar(movimiento, tx);
      }),
    );
  }

  /**
   * Da por perdido un envase que sigue en poder de un cliente (CU-108,
   * decisión del administrador). Corre dentro de la transacción de quien
   * decide (`tx`) para que la baja y el cierre del caso sean una sola cosa. Un
   * envase que ya no está con un cliente es 409: el caso ya no corresponde.
   */
  porPerdida(
    cylinderId: string,
    reason: string,
    distributorId: string,
    actorUserId: string,
    tx: Transaccion,
  ): Promise<void> {
    return conErroresHttp(async () => {
      const envase = await this.envases.bloquear(tx, cylinderId, distributorId);
      if (!envase) throw new NotFoundException('Envase no encontrado');
      const movimiento = envase.darPorPerdido(
        reason,
        actorUserId,
        this.reloj.ahora(),
      );
      await this.envases.guardar(tx, envase);
      await this.movimientos.registrar(movimiento, tx);
    });
  }
}
