import { ConfigService } from '@nestjs/config';

const OSRM_PUBLICO = 'https://router.project-osrm.org';

/** El OSRM propio; el público sólo con `NODE_ENV` de desarrollo o test. */
export function urlDeOsrm(config: ConfigService): string | null {
  const propio = config.get<string>('OSRM_BASE_URL');
  if (propio) return propio.replace(/\/+$/, '');
  const entorno = config.get<string>('NODE_ENV');
  return entorno === 'development' || entorno === 'test' ? OSRM_PUBLICO : null;
}
