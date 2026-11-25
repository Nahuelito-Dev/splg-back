import { Injectable } from '@nestjs/common';
import { Envase, movimientoDeAlta, nuevoEnvase } from '../domain/envase';
import { CylinderMovementRepositoryPort } from '../domain/ports/cylinder-movement.repository.port';
import { CylinderRepositoryPort } from '../domain/ports/cylinder.repository.port';
import { ProductCatalogPort } from '../domain/ports/product-catalog.port';
import { conErroresHttp } from './domain-error.translator';

export interface AltaDeEnvase {
  serial: string;
  gasCylinderId?: string;
  deposit?: number;
}

/**
 * Da de alta un envase físico en el depósito, con su primer movimiento. El
 * serial es único por distribuidora: dos empresas pueden tener envases con el
 * mismo serial de fábrica.
 */
@Injectable()
export class CreateCylinderUseCase {
  constructor(
    private readonly envases: CylinderRepositoryPort,
    private readonly movimientos: CylinderMovementRepositoryPort,
    private readonly catalogo: ProductCatalogPort,
  ) {}

  execute(datos: AltaDeEnvase, distributorId: string): Promise<Envase> {
    return conErroresHttp(async () => {
      // El producto tiene que existir y ser de la misma distribuidora (404).
      if (datos.gasCylinderId) {
        await this.catalogo.asegurarProducto(
          datos.gasCylinderId,
          distributorId,
        );
      }
      const envase = await this.envases.crear(
        nuevoEnvase(distributorId, datos),
      );
      await this.movimientos.registrar(movimientoDeAlta(envase));
      return envase;
    });
  }
}
