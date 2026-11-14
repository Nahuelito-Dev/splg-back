import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';
import { PlatformCompaniesController } from './platform-companies.controller';

/**
 * Lo de la plataforma dueña del sistema: nombre y contacto (E0) y las empresas
 * con su marca de empresa propia. `DistributorService` llega por el módulo
 * global de distribuidoras.
 */
@Module({ controllers: [PlatformController, PlatformCompaniesController] })
export class PlatformModule {}
