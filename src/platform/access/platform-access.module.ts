import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DistributorModule as ModuloDeLaEmpresa } from '../modules/entities/distributor-module.entity';
import { DistributorSubscription } from '../modules/entities/distributor-subscription.entity';
import { PlatformPlanModule } from '../modules/entities/platform-plan-module.entity';
import { PlatformPlan } from '../modules/entities/platform-plan.entity';
import { AccesoDeLaEmpresa } from './acceso-de-la-empresa.service';

/**
 * Acceso de las empresas a la plataforma (DISENO-PLATAFORMA-ORIXTECH §6):
 * planes, suscripciones y excepciones de módulos, y `AccesoDeLaEmpresa`, que
 * los combina. Global: lo consultan el `ModuloGuard`, los procesos
 * automáticos (`EmpresasParaProceso`) y los servicios que esconden lo de un
 * módulo apagado (medios de pago).
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PlatformPlan,
      PlatformPlanModule,
      DistributorSubscription,
      ModuloDeLaEmpresa,
    ]),
  ],
  providers: [AccesoDeLaEmpresa],
  exports: [AccesoDeLaEmpresa],
})
export class PlatformAccessModule {}
