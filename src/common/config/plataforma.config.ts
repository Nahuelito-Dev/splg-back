import { registerAs } from '@nestjs/config';

/** Nombre neutro mientras la empresa dueña de la plataforma no tenga uno decidido (D11). */
export const NOMBRE_DE_PLATAFORMA_POR_DEFECTO = 'SPLG';

export interface ConfiguracionDePlataforma {
  /** Nombre comercial: lo muestran el panel, las apps, los correos y los avisos. */
  name: string;
  /** Razón social. */
  legalName: string;
  /** Correo de contacto del soporte; vacío si no se configuró. */
  supportEmail: string | null;
}

/**
 * La plataforma (dueña del sistema, no una distribuidora), en un solo lugar:
 * `PLATFORM_NAME`, `PLATFORM_LEGAL_NAME` y `PLATFORM_SUPPORT_EMAIL`. Lo que
 * falta toma el nombre neutro. Se lee con `ConfigService.get('plataforma')`.
 */
export function leerConfiguracionDePlataforma(
  env: Record<string, string | undefined>,
): ConfiguracionDePlataforma {
  const texto = (v: string | undefined): string | null => {
    const limpio = v?.trim();
    return limpio ? limpio : null;
  };
  const name = texto(env.PLATFORM_NAME) ?? NOMBRE_DE_PLATAFORMA_POR_DEFECTO;
  return {
    name,
    legalName: texto(env.PLATFORM_LEGAL_NAME) ?? name,
    supportEmail: texto(env.PLATFORM_SUPPORT_EMAIL),
  };
}

export const plataformaConfig = registerAs('plataforma', () =>
  leerConfiguracionDePlataforma(process.env),
);
