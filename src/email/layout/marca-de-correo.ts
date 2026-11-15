import { leerConfiguracionDePlataforma } from '../../common/config/plataforma.config';

/** Los colores con los que se pinta un correo. */
export interface PaletaDeCorreo {
  /** Fondo de la página, alrededor de la tarjeta. */
  fondo: string;
  /** Encabezado de la tarjeta y su texto. */
  encabezado: string;
  encabezadoTexto: string;
  encabezadoSuave: string;
  /** Línea fina arriba del encabezado: el degradé de la marca. */
  brillo: [string, string];
  /** Cuadradito del logo (degradé) y la letra que lleva adentro. */
  logo: [string, string];
  logoTexto: string;
  /** Botón principal: degradé, borde y texto. */
  boton: [string, string];
  botonBorde: string;
  /** Enlaces y la etiqueta chica arriba del título. */
  acento: string;
}

/**
 * Con qué marca sale un correo. Los de la plataforma (cuenta, verificación,
 * soporte) llevan la marca de la plataforma; los operativos de una
 * distribuidora (avisos, flota, stock, rendiciones) llevan su nombre con el
 * sistema visual Brasa y la plataforma chiquita en el pie.
 */
export interface MarcaDeCorreo {
  tipo: 'plataforma' | 'distribuidora';
  /** Nombre que encabeza el correo. */
  nombre: string;
  /** Nombre de la plataforma (OrixTech): firma el pie de todos. */
  plataforma: string;
  /** Razón social de la plataforma, para el aviso legal del pie. */
  razonSocial: string;
  /** Correo de soporte de la plataforma; `null` si no se configuró. */
  contacto: string | null;
  paleta: PaletaDeCorreo;
}

/** Fallback del encabezado cuando no se pudo leer el nombre de la distribuidora. */
export const DISTRIBUIDORA_SIN_NOMBRE = 'Tu distribuidora';

/** OrixTech: degradé naranja → amarillo sobre fondo claro. */
const PALETA_PLATAFORMA: PaletaDeCorreo = {
  fondo: '#F4F5F7',
  encabezado: '#FFFFFF',
  encabezadoTexto: '#111827',
  encabezadoSuave: '#6B7280',
  brillo: ['#F97316', '#FACC15'],
  logo: ['#F97316', '#FACC15'],
  logoTexto: '#FFFFFF',
  boton: ['#EA580C', '#C2410C'],
  botonBorde: '#B13B0A',
  acento: '#C2410C',
};

/** Brasa (panel): tinta oscura con el brillo cálido de la llama y el botón principal del panel. */
const PALETA_BRASA: PaletaDeCorreo = {
  fondo: '#F5F6F8',
  encabezado: '#0B0F16',
  encabezadoTexto: '#FFFFFF',
  encabezadoSuave: '#98A2B3',
  brillo: ['#F26B1D', '#FFB020'],
  logo: ['#D24E0D', '#B23F0A'],
  logoTexto: '#FFFFFF',
  boton: ['#D24E0D', '#B23F0A'],
  botonBorde: '#A13A09',
  acento: '#B8430B',
};

type Entorno = Record<string, string | undefined>;

/** La marca de la plataforma, leída de `PLATFORM_NAME`, `PLATFORM_LEGAL_NAME` y `PLATFORM_SUPPORT_EMAIL`. */
export function marcaDePlataforma(env: Entorno = process.env): MarcaDeCorreo {
  const plataforma = leerConfiguracionDePlataforma(env);
  return {
    tipo: 'plataforma',
    nombre: plataforma.name,
    plataforma: plataforma.name,
    razonSocial: plataforma.legalName,
    contacto: plataforma.supportEmail,
    paleta: PALETA_PLATAFORMA,
  };
}

/** La marca de una distribuidora (Brasa), con la plataforma en el pie. */
export function marcaDeDistribuidora(
  nombre: string | null | undefined,
  env: Entorno = process.env,
): MarcaDeCorreo {
  const plataforma = marcaDePlataforma(env);
  const limpio = nombre?.trim();
  return {
    ...plataforma,
    tipo: 'distribuidora',
    nombre: limpio ? limpio : DISTRIBUIDORA_SIN_NOMBRE,
    paleta: PALETA_BRASA,
  };
}

/**
 * El nombre de la distribuidora a partir de sus administradores (`AdminService.findAll`
 * los trae con la relación `distributor`): evita otra consulta en los avisos que ya los leen.
 */
export function nombreDeDistribuidoraDeAdmins(
  admins: ReadonlyArray<{ distributor?: { name?: string | null } | null }>,
): string | null {
  for (const admin of admins) {
    const nombre = admin.distributor?.name?.trim();
    if (nombre) return nombre;
  }
  return null;
}
