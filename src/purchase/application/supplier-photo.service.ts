import { Injectable } from '@nestjs/common';
import { Supplier } from '../entities/supplier.entity';
import { SupplierService } from './supplier.service';
import {
  DestinoDeFoto,
  EnlaceDeFoto,
  EntityPhotoService,
} from '../../s3/entity-photo.service';

const DESTINO: DestinoDeFoto = {
  entity: Supplier,
  idProp: 'supplierId',
  keyProp: 'photoKey',
};

/**
 * Foto principal del proveedor. El tenant lo resuelve `SupplierService.findOne`
 * (404 si es de otra distribuidora); acá sólo se guarda, se saca y se firma.
 */
@Injectable()
export class SupplierPhotoService {
  constructor(
    private readonly suppliers: SupplierService,
    private readonly fotos: EntityPhotoService,
  ) {}

  /** Completa la URL firmada de cada proveedor (firmar es local). */
  async firmar(proveedores: Supplier | readonly Supplier[]): Promise<void> {
    await this.fotos.firmar(proveedores, (s) => s.photoKey);
  }

  /** Sube o reemplaza la foto y devuelve el enlace vigente. */
  async subir(
    id: string,
    distributorId: string,
    file: Express.Multer.File | undefined,
  ): Promise<EnlaceDeFoto> {
    await this.suppliers.findOne(id, distributorId);
    await this.fotos.guardar(
      DESTINO,
      id,
      file,
      `suppliers/${distributorId}/${id}`,
    );
    return this.enlace(id, distributorId);
  }

  async quitar(id: string, distributorId: string): Promise<EnlaceDeFoto> {
    await this.suppliers.findOne(id, distributorId);
    await this.fotos.quitar(DESTINO, id);
    return this.enlace(id, distributorId);
  }

  async enlace(id: string, distributorId: string): Promise<EnlaceDeFoto> {
    const proveedor = await this.suppliers.findOne(id, distributorId);
    return this.fotos.enlace(proveedor.photoKey);
  }
}
