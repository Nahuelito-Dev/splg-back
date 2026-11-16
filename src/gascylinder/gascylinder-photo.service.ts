import { Injectable, NotFoundException } from '@nestjs/common';
import { GasCylinder } from './entities/gascylinder.entity';
import { GasCylinderService } from './gascylinder.service';
import {
  DestinoDeFoto,
  EnlaceDeFoto,
  EntityPhotoService,
} from '../s3/entity-photo.service';

const DESTINO: DestinoDeFoto = {
  entity: GasCylinder,
  idProp: 'gasCylinderId',
  keyProp: 'photoKey',
};

/**
 * Imagen del producto (garrafa). El tenant lo resuelve
 * `GasCylinderService.findOne` (404 si es de otra distribuidora).
 */
@Injectable()
export class GasCylinderPhotoService {
  constructor(
    private readonly products: GasCylinderService,
    private readonly fotos: EntityPhotoService,
  ) {}

  /** Completa la URL firmada en uno o varios productos. */
  firmar(productos: GasCylinder | readonly GasCylinder[]): Promise<void> {
    return this.fotos.firmar(productos, (g) => g.photoKey);
  }

  async subir(
    id: string,
    distributorId: string,
    file: Express.Multer.File | undefined,
  ): Promise<GasCylinder> {
    await this.products.findOne(id, distributorId);
    await this.fotos.guardar(
      DESTINO,
      id,
      file,
      `gascylinders/${distributorId}/${id}`,
    );
    return this.recargar(id, distributorId);
  }

  async quitar(id: string, distributorId: string): Promise<GasCylinder> {
    await this.products.findOne(id, distributorId);
    await this.fotos.quitar(DESTINO, id);
    return this.recargar(id, distributorId);
  }

  async enlace(
    id: string,
    distributorId: string | null,
    soloActivos = false,
  ): Promise<EnlaceDeFoto> {
    const producto = await this.products.findOne(id, distributorId);
    // El camino público no sirve la imagen de un producto dado de baja.
    if (soloActivos && !producto.isActive) {
      throw new NotFoundException('Garrafa no encontrada');
    }
    return this.fotos.enlace(producto.photoKey);
  }

  private async recargar(
    id: string,
    distributorId: string,
  ): Promise<GasCylinder> {
    const producto = await this.products.findOne(id, distributorId);
    await this.firmar(producto);
    return producto;
  }
}
