import { ImportCleanupCron } from './import-cleanup.cron';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GasCylinderModule } from '../gascylinder/gascylinder.module';
import { PurchaseModule } from '../purchase/purchase.module';
import { StockModule } from '../stock/stock.module';
import { ImportJob } from './entities/import-job.entity';
import { ImportController } from './import.controller';
import { ImportHandlerRegistry } from './import-handler.registry';
import { ImportService } from './import.service';
import { ImportTemplateService } from './import-template.service';
import { GarrafasImportHandler } from './resources/garrafas.handler';
import { PreciosImportHandler } from './resources/precios.handler';
import { ProveedoresImportHandler } from './resources/proveedores.handler';
import { StockImportHandler } from './resources/stock.handler';

/**
 * Importación masiva desde Excel o CSV (API v2). No tiene reglas de negocio
 * propias: valida y aplica con los servicios de catálogo, stock y compras.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ImportJob]),
    GasCylinderModule,
    StockModule,
    PurchaseModule,
  ],
  controllers: [ImportController],
  providers: [
    ImportService,
    ImportCleanupCron,
    ImportTemplateService,
    ImportHandlerRegistry,
    GarrafasImportHandler,
    PreciosImportHandler,
    StockImportHandler,
    ProveedoresImportHandler,
  ],
})
export class ImportModule {}
