import { MODULE_METADATA } from '@nestjs/common/constants';
import { PlatformController } from './platform.controller';
import { PlatformCompaniesController } from './platform-companies.controller';
import { PlatformModule } from './platform.module';
import { PlatformConsoleController } from './presentation/platform-console.controller';
import { PlatformMetricsRepository } from './infrastructure/platform-metrics.repository';
import {
  CompanyModulesController,
  MeFeaturesController,
} from './modules/company-modules.controller';
import { CompanyModulesService } from './modules/company-modules.service';
import { PlatformModulesController } from './modules/platform-modules.controller';
import { PublicFeaturesController } from './modules/public-features.controller';

describe('PlatformModule', () => {
  it('registra los controllers público, de E3, de empresa propia y de módulos con su lado de lectura', () => {
    const controllers: unknown = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      PlatformModule,
    );
    const providers: unknown = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      PlatformModule,
    );
    expect(controllers).toEqual([
      PlatformController,
      PlatformConsoleController,
      PlatformCompaniesController,
      PlatformModulesController,
      CompanyModulesController,
      MeFeaturesController,
      PublicFeaturesController,
    ]);
    expect(providers).toEqual(
      expect.arrayContaining([
        PlatformMetricsRepository,
        CompanyModulesService,
      ]),
    );
  });
});
