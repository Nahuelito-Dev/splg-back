import { Injectable } from '@nestjs/common';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { ProductCatalogPort } from '../domain/ports/product-catalog.port';

/** Adaptador: el catálogo de productos lo resuelve el módulo `gascylinder`. */
@Injectable()
export class ProductCatalogAdapter extends ProductCatalogPort {
  constructor(private readonly gasCylinders: GasCylinderService) {
    super();
  }

  async asegurarProducto(
    gasCylinderId: string,
    distributorId: string,
  ): Promise<void> {
    await this.gasCylinders.findOne(gasCylinderId, distributorId);
  }
}
