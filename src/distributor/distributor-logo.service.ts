import { Injectable, NotFoundException } from '@nestjs/common';
import { Distributor } from './entities/distributor.entity';
import { DistributorService } from './distributor.service';
import {
  DestinoDeFoto,
  EnlaceDeFoto,
  EntityPhotoService,
} from '../s3/entity-photo.service';

const DESTINO: DestinoDeFoto = {
  entity: Distributor,
  idProp: 'distributorId',
  keyProp: 'logoKey',
};

/**
 * Logo de la distribuidora en S3. El texto libre `logo_url` queda como
 * respaldo: se sigue devolviendo mientras no se suba un logo.
 */
@Injectable()
export class DistributorLogoService {
  constructor(
    private readonly distributors: DistributorService,
    private readonly fotos: EntityPhotoService,
  ) {}

  /** Completa la URL firmada del logo en una o varias distribuidoras. */
  firmar(distribuidoras: Distributor | readonly Distributor[]): Promise<void> {
    return this.fotos.firmar(distribuidoras, (d) => d.logoKey);
  }

  /**
   * Un admin sólo toca la suya (404 para otra, como en el resto de la API);
   * el super admin, cualquiera. `alcance` es la distribuidora del admin, o
   * `null` para el super admin.
   */
  private async resolver(
    id: string,
    alcance: string | null,
  ): Promise<Distributor> {
    if (alcance && alcance !== id) {
      throw new NotFoundException(`Distribuidora ${id} no encontrada`);
    }
    return this.distributors.findOne(id);
  }

  async subir(
    id: string,
    alcance: string | null,
    file: Express.Multer.File | undefined,
  ): Promise<Distributor> {
    await this.resolver(id, alcance);
    await this.fotos.guardar(DESTINO, id, file, `distributors/${id}/logo`);
    return this.recargar(id);
  }

  async quitar(id: string, alcance: string | null): Promise<Distributor> {
    await this.resolver(id, alcance);
    await this.fotos.quitar(DESTINO, id);
    return this.recargar(id);
  }

  async enlace(id: string, alcance: string | null): Promise<EnlaceDeFoto> {
    const distribuidora = await this.resolver(id, alcance);
    return this.fotos.enlace(distribuidora.logoKey, distribuidora.logoUrl);
  }

  private async recargar(id: string): Promise<Distributor> {
    const distribuidora = await this.distributors.findOne(id);
    await this.firmar(distribuidora);
    return distribuidora;
  }
}
