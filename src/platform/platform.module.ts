import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';
import { PlatformActivityService } from './application/platform-activity.service';
import { PlatformCompaniesService } from './application/platform-companies.service';
import { PlatformProcessesService } from './application/platform-processes.service';
import { PlatformScheduleService } from './application/platform-schedule.service';
import { PlatformUsageService } from './application/platform-usage.service';
import { PlatformMetricsRepository } from './infrastructure/platform-metrics.repository';
import { PlatformConsoleController } from './presentation/platform-console.controller';
import { PlatformCompaniesController } from './platform-companies.controller';
import {
  CompanyModulesController,
  MeFeaturesController,
} from './modules/company-modules.controller';
import { CompanyModulesService } from './modules/company-modules.service';
import { ModulosDeLaEmpresaRepository } from './modules/modulos-de-la-empresa.repository';
import { PlatformModulesController } from './modules/platform-modules.controller';
import { PublicFeaturesController } from './modules/public-features.controller';

/**
 * Lo de la plataforma dueña del sistema: nombre y contacto (E0, público) y el
 * panel de plataforma (E3, sólo el administrador general): tablero, empresas,
 * procesos, uso del lector, actividad y frecuencia de las tareas programadas;
 * y los módulos por distribuidora (P1): los que cambia la plataforma, los que
 * ve la empresa y los que leen las apps.
 * `DistributorModule` y `ProcessRunModule` son globales.
 */
@Module({
  controllers: [
    PlatformController,
    PlatformConsoleController,
    PlatformCompaniesController,
    PlatformModulesController,
    CompanyModulesController,
    MeFeaturesController,
    PublicFeaturesController,
  ],
  providers: [
    PlatformMetricsRepository,
    PlatformCompaniesService,
    PlatformProcessesService,
    PlatformUsageService,
    PlatformActivityService,
    PlatformScheduleService,
    ModulosDeLaEmpresaRepository,
    CompanyModulesService,
  ],
})
export class PlatformModule {}
