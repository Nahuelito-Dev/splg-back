import { SetMetadata } from '@nestjs/common';

export const ALCANCE_DE_SOPORTE_KEY = 'alcanceDeSoporte';

/** Alcances de una sesión de soporte que habilitan algo más que lo básico. */
export type AlcanceDeSoporte = 'personal_data' | 'files' | 'exports';

/**
 * El endpoint entrega un archivo (`files`: PDFs) o un exporte (`exports`: CSV y
 * Excel). En modo soporte, sin ese alcance aprobado, el `AlcanceGuard` responde
 * 403 `SUPPORT_SCOPE_REQUIRED` (§4.6). Las URL firmadas de S3 no necesitan la
 * marca: las controla `S3Service` en un solo lugar.
 */
export const RequiereAlcanceDeSoporte = (alcance: AlcanceDeSoporte) =>
  SetMetadata(ALCANCE_DE_SOPORTE_KEY, alcance);
