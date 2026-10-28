import { Injectable } from '@nestjs/common';
import { ImportResource } from './domain/import.enums';
import { ImportHandler } from './domain/import.types';
import { GarrafasImportHandler } from './resources/garrafas.handler';
import { PreciosImportHandler } from './resources/precios.handler';
import { ProveedoresImportHandler } from './resources/proveedores.handler';
import { StockImportHandler } from './resources/stock.handler';

/** Qué handler atiende cada recurso. */
@Injectable()
export class ImportHandlerRegistry {
  private readonly porRecurso: Record<ImportResource, ImportHandler>;

  constructor(
    garrafas: GarrafasImportHandler,
    precios: PreciosImportHandler,
    stock: StockImportHandler,
    proveedores: ProveedoresImportHandler,
  ) {
    this.porRecurso = {
      [ImportResource.GARRAFAS]: garrafas,
      [ImportResource.PRECIOS]: precios,
      [ImportResource.STOCK]: stock,
      [ImportResource.PROVEEDORES]: proveedores,
    };
  }

  de(recurso: ImportResource): ImportHandler {
    return this.porRecurso[recurso];
  }
}
