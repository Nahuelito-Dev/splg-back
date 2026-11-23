import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DistributorService } from './distributor.service';
import { DistributorController } from './distributor.controller';
import { Distributor } from './entities/distributor.entity';
import { ModuleConfig } from './entities/module-config.entity';
import { DistributorLogoService } from './distributor-logo.service';
import { ModuleConfigService } from './module-config.service';
import { ExpressConfigController } from './express-config.controller';
import { ExpressSettingsService } from './express-settings.service';
import { PaymentSurchargeConfigController } from './payment-surcharge-config.controller';
import { PaymentSurchargeSettingsService } from './payment-surcharge-settings.service';
import { ContainerChargeConfigController } from './container-charge-config.controller';
import { ContainerChargeSettingsService } from './container-charge-settings.service';
import { ModuleConfigController } from './module-config.controller';
import { ProcessConfigService } from './process-config.service';
import { DispatchSettingsService } from './dispatch-settings.service';
import { ScheduledTasksSettingsService } from './scheduled-tasks-settings.service';
import { S3Module } from '../s3/s3.module';
import { MercadoPagoCredentials } from './entities/mercadopago-credentials.entity';
import { CredentialsEncryptionService } from './credentials-encryption.service';
import {
  MERCADOPAGO_FETCH,
  MercadoPagoCredentialsService,
} from './mercadopago-credentials.service';
import { MercadoPagoCredentialsController } from './mercadopago-credentials.controller';
import { DistributorTheme } from './entities/distributor-theme.entity';
import { DistributorThemeService } from './theme/distributor-theme.service';
import { CompanyThemeController } from './theme/company-theme.controller';

/**
 * Global: `DistributorService` es transversal (lo consumen AuthGuard y el
 * scoping de casi todos los módulos), y la entidad Distributor es referenciada
 * por muchas otras. Evita re-importar el módulo en cada feature. Exporta el
 * servicio y no el repositorio: los demás módulos leen distribuidoras por acá.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Distributor,
      ModuleConfig,
      MercadoPagoCredentials,
      DistributorTheme,
    ]),
    S3Module, // logo
  ],
  // ExpressConfigController antes que ModuleConfigController: su ruta fija
  // `/module-config/express_dispatch` tiene que ganarle a `/module-config/:process`.
  controllers: [
    DistributorController,
    ExpressConfigController,
    PaymentSurchargeConfigController,
    ContainerChargeConfigController,
    ModuleConfigController,
    MercadoPagoCredentialsController,
    CompanyThemeController,
  ],
  providers: [
    DistributorService,
    DistributorLogoService,
    ModuleConfigService,
    DispatchSettingsService,
    ScheduledTasksSettingsService,
    ProcessConfigService,
    ExpressSettingsService,
    PaymentSurchargeSettingsService,
    ContainerChargeSettingsService,
    CredentialsEncryptionService,
    { provide: MERCADOPAGO_FETCH, useValue: fetch },
    MercadoPagoCredentialsService,
    DistributorThemeService,
  ],
  exports: [
    DistributorService,
    ModuleConfigService,
    DispatchSettingsService,
    ScheduledTasksSettingsService,
    ProcessConfigService,
    ExpressSettingsService,
    PaymentSurchargeSettingsService,
    ContainerChargeSettingsService,
    MercadoPagoCredentialsService,
    DistributorThemeService,
  ],
})
export class DistributorModule {}
