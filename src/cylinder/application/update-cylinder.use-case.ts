import { Injectable, NotFoundException } from '@nestjs/common';
import type { CambiosDeEnvase } from '../domain/envase';
import { ClockPort } from '../domain/ports/clock.port';
import { CylinderRepositoryPort } from '../domain/ports/cylinder.repository.port';
import { ProductCatalogPort } from '../domain/ports/product-catalog.port';
import { UnitOfWorkPort } from '../domain/ports/unit-of-work.port';
import { conErroresHttp } from './domain-error.translator';

/**
 * Edita los datos maestros del envase (serial, producto, depósito,
 * fabricación). El estado no se toca. Un envase dado de baja ya no se edita.
 */
@Injectable()
export class UpdateCylinderUseCase {
  constructor(
    private readonly envases: CylinderRepositoryPort,
    private readonly catalogo: ProductCatalogPort,
    private readonly uow: UnitOfWorkPort,
    private readonly reloj: ClockPort,
  ) {}

  execute(
    cylinderId: string,
    cambios: CambiosDeEnvase,
    distributorId: string,
  ): Promise<void> {
    return conErroresHttp(async () => {
      if (cambios.gasCylinderId) {
        await this.catalogo.asegurarProducto(
          cambios.gasCylinderId,
          distributorId,
        );
      }
      await this.uow.enTransaccion(async (tx) => {
        const envase = await this.envases.bloquear(
          tx,
          cylinderId,
          distributorId,
        );
        if (!envase) throw new NotFoundException('Envase no encontrado');
        envase.editar(cambios, this.reloj.ahora());
        await this.envases.guardar(tx, envase);
      });
    });
  }
}
