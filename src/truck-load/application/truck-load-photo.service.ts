import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CargaNoEncontradaError } from '../domain/errors/truck-load.errors';
import { TruckLoad } from '../entities/truck-load.entity';
import {
  DestinoDeFoto,
  EnlaceDeFoto,
  EntityPhotoService,
} from '../../s3/entity-photo.service';

const DESTINO: DestinoDeFoto = {
  entity: TruckLoad,
  idProp: 'loadId',
  keyProp: 'photoKey',
};

/**
 * Foto principal de la carga del camión. Subir y quitar son del personal
 * administrativo; ver, también del chofer dueño de la carga (`alcance` es su
 * `delivery_id`, como en `TruckLoadQueryService.detalle`). Una carga de otra
 * distribuidora o de otro chofer es 404.
 */
@Injectable()
export class TruckLoadPhotoService {
  constructor(
    @InjectRepository(TruckLoad)
    private readonly loads: Repository<TruckLoad>,
    private readonly fotos: EntityPhotoService,
  ) {}

  /** Sube o reemplaza la foto y devuelve el enlace vigente. */
  async subir(
    id: string,
    distributorId: string,
    file: Express.Multer.File | undefined,
  ): Promise<EnlaceDeFoto> {
    await this.buscar(id, distributorId);
    await this.fotos.guardar(
      DESTINO,
      id,
      file,
      `truck-loads/${distributorId}/${id}`,
    );
    return this.enlace(id, distributorId);
  }

  async quitar(id: string, distributorId: string): Promise<EnlaceDeFoto> {
    await this.buscar(id, distributorId);
    await this.fotos.quitar(DESTINO, id);
    return this.enlace(id, distributorId);
  }

  async enlace(
    id: string,
    distributorId: string,
    alcance?: string,
  ): Promise<EnlaceDeFoto> {
    const carga = await this.buscar(id, distributorId, alcance);
    return this.fotos.enlace(carga.photoKey);
  }

  private async buscar(
    id: string,
    distributorId: string,
    alcance?: string,
  ): Promise<TruckLoad> {
    const carga = await this.loads.findOne({
      where: { loadId: id, distributorId },
    });
    if (!carga || (alcance !== undefined && carga.deliveryId !== alcance)) {
      throw new CargaNoEncontradaError(id);
    }
    return carga;
  }
}
