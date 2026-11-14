import { MODULE_METADATA } from '@nestjs/common/constants';
import { PlatformController } from './platform.controller';
import { PlatformCompaniesController } from './platform-companies.controller';
import { PlatformModule } from './platform.module';
import { PlatformConsoleController } from './presentation/platform-console.controller';
import { PlatformMetricsRepository } from './infrastructure/platform-metrics.repository';

describe('PlatformModule', () => {
  it('registra los controllers público, de E3 y de empresa propia con su lado de lectura', () => {
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
    ]);
    expect(providers).toEqual(
      expect.arrayContaining([PlatformMetricsRepository]),
    );
  });
});
