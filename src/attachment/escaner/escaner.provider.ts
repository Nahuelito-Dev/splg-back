import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EscanerClamAv } from './escaner-clamav';
import { EscanerDeArchivos } from './escaner-de-archivos.port';
import { SinEscaneo } from './sin-escaneo';

/** Puerto de omisión de `clamd`. */
export const PUERTO_DE_CLAMAV = 3310;
/** Tope de un escaneo (un PDF de 10 MB tarda pocos segundos). */
export const TIMEOUT_DE_CLAMAV_MS = 30_000;

const logger = new Logger('EscanerDeArchivos');

/**
 * ClamAV si hay `CLAMAV_HOST` (y no está `CLAMAV_DISABLED`); si no, sin
 * escaneo, con un aviso en el log: los PDF y documentos del chat quedan
 * limpios sin revisar. En producción Joi exige el host o el apagado explícito.
 */
export function escanerSegunLaConfiguracion(
  config: ConfigService,
): EscanerDeArchivos {
  const host = config.get<string>('CLAMAV_HOST')?.trim();
  const apagado = String(config.get('CLAMAV_DISABLED') ?? '') === 'true';
  if (!host || apagado) {
    logger.warn(
      apagado
        ? 'Antivirus apagado (CLAMAV_DISABLED=true): los archivos del chat se dan por limpios sin escanearlos'
        : 'Sin CLAMAV_HOST: los archivos del chat se dan por limpios sin escanearlos',
    );
    return new SinEscaneo();
  }
  return new EscanerClamAv({
    host,
    port: Number(config.get('CLAMAV_PORT') ?? PUERTO_DE_CLAMAV),
    timeoutMs: Number(config.get('CLAMAV_TIMEOUT_MS') ?? TIMEOUT_DE_CLAMAV_MS),
  });
}

export const ESCANER_DE_ARCHIVOS: Provider = {
  provide: EscanerDeArchivos,
  inject: [ConfigService],
  useFactory: escanerSegunLaConfiguracion,
};
