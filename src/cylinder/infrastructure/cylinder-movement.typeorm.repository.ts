import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MovimientoDeEnvase } from '../domain/envase';
import { CylinderMovementRepositoryPort } from '../domain/ports/cylinder-movement.repository.port';
import { Transaccion } from '../domain/ports/unit-of-work.port';
import { CylinderMovement } from '../entities/cylinder-movement.entity';
import { managerDe } from './typeorm-unit-of-work.adapter';

/** Adaptador TypeORM del historial de movimientos (`cylinder_movement`). */
@Injectable()
export class CylinderMovementTypeormRepository extends CylinderMovementRepositoryPort {
  constructor(
    @InjectRepository(CylinderMovement)
    private readonly movements: Repository<CylinderMovement>,
  ) {
    super();
  }

  async registrar(
    movimiento: MovimientoDeEnvase,
    tx?: Transaccion,
  ): Promise<void> {
    const movements = tx
      ? managerDe(tx).getRepository(CylinderMovement)
      : this.movements;
    await movements.save(
      movements.create({
        cylinderId: movimiento.cylinderId,
        distributorId: movimiento.distributorId,
        fromState: movimiento.fromState,
        toState: movimiento.toState,
        orderId: movimiento.orderId,
        actorUserId: movimiento.actorUserId,
        note: movimiento.note,
      }),
    );
  }
}
