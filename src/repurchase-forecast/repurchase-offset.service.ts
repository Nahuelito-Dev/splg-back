import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { calcularOffset } from './domain/ajuste-por-cliente';
import { RepurchaseOffset } from './entities/repurchase-offset.entity';
import { RepurchaseInvitationService } from './repurchase-invitation.service';

/**
 * El ajuste por cliente de la fecha de recompra (M3a): se guarda por cliente y
 * distribuidora y se recalcula cuando se le entrega un pedido, con el error de
 * sus invitaciones anteriores (la medición de la mejora E).
 */
@Injectable()
export class RepurchaseOffsetService {
  constructor(
    @InjectRepository(RepurchaseOffset)
    private readonly repo: Repository<RepurchaseOffset>,
    private readonly invitaciones: RepurchaseInvitationService,
  ) {}

  /** Los ajustes guardados de los clientes dados (sólo los que no son cero). */
  async deClientes(
    distributorId: string,
    userIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const filas = await this.repo.find({
      where: { distributorId, userId: In([...userIds]) },
    });
    return new Map(filas.map((f) => [f.userId, f.offsetDays]));
  }

  /** Recalcula y guarda el ajuste del cliente; devuelve los días. */
  async recalcular(
    distributorId: string,
    userId: string,
    ahora: Date,
  ): Promise<number> {
    const errores = await this.invitaciones.erroresDelCliente(
      distributorId,
      userId,
    );
    const offsetDays = calcularOffset(errores);
    await this.repo.upsert(
      {
        distributorId,
        userId,
        offsetDays,
        sampleSize: errores.length,
        computedAt: ahora,
      },
      ['userId', 'distributorId'],
    );
    return offsetDays;
  }
}
