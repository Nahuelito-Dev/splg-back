import { ConfigService } from '@nestjs/config';
import { leerConfiguracionDePlataforma } from '../common/config/plataforma.config';
import { PlatformController } from './platform.controller';

describe('PlatformController', () => {
  it('GET /v2/platform devuelve lo configurado', () => {
    const config = new ConfigService({
      plataforma: leerConfiguracionDePlataforma({ PLATFORM_NAME: 'Gasnet' }),
    });
    expect(new PlatformController(config).datos()).toEqual({
      name: 'Gasnet',
      legalName: 'Gasnet',
      supportEmail: null,
    });
  });
});
