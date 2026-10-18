import { MaintenanceDocumentKind } from '../entities/maintenance-plan.entity';

/** Los datos propios de un tipo de documento: texto plano, una clave por campo. */
export type DetalleDeDocumento = Record<string, string>;

interface CampoDelDetalle {
  clave: string;
  /** Cómo se nombra el campo en el mensaje de error. */
  etiqueta: string;
  maximo: number;
  /** `true`: tiene que ser un día real `YYYY-MM-DD`. */
  fecha?: boolean;
}

/**
 * Forma del detalle de cada tipo de documento del personal (CU-183 a CU-185):
 * todos los campos son obligatorios y no se admiten otros. Los tipos que no
 * figuran acá (seguro, VTV, licencia, service, genérico) no llevan detalle.
 */
const CAMPOS: Partial<
  Record<MaintenanceDocumentKind, readonly CampoDelDetalle[]>
> = {
  [MaintenanceDocumentKind.HAZMAT_DRIVER_COURSE]: [
    {
      clave: 'certificateNumber',
      etiqueta: 'número de certificado',
      maximo: 40,
    },
    { clave: 'issuer', etiqueta: 'emisor', maximo: 80 },
  ],
  [MaintenanceDocumentKind.PSYCHOPHYSICAL]: [
    {
      clave: 'examDate',
      etiqueta: 'fecha del examen',
      maximo: 10,
      fecha: true,
    },
  ],
  [MaintenanceDocumentKind.ART_COVERAGE]: [
    { clave: 'insurer', etiqueta: 'aseguradora', maximo: 80 },
    { clave: 'policyNumber', etiqueta: 'número de póliza', maximo: 40 },
  ],
};

const SOLO_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

function esDiaReal(texto: string): boolean {
  const m = SOLO_FECHA.exec(texto);
  if (!m) return false;
  const control = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return (
    control.getUTCFullYear() === +m[1] &&
    control.getUTCMonth() === +m[2] - 1 &&
    control.getUTCDate() === +m[3]
  );
}

export type ResultadoDelDetalle =
  | { ok: true; detalle: DetalleDeDocumento | null }
  | { ok: false; motivo: string };

/** Si el tipo de documento exige un detalle (y por lo tanto el alta lo tiene que traer). */
export function exigeDetalle(tipo: MaintenanceDocumentKind | null): boolean {
  return tipo !== null && CAMPOS[tipo] !== undefined;
}

/**
 * Valida el detalle de una tarea contra la forma de su tipo de documento. Si
 * falla, el motivo nombra el campo. Función pura: no toca datos.
 */
export function validarDetalle(
  tipo: MaintenanceDocumentKind | null,
  detalle: unknown,
): ResultadoDelDetalle {
  const campos = tipo ? CAMPOS[tipo] : undefined;
  const vacio = detalle === undefined || detalle === null;

  if (!campos) {
    return vacio
      ? { ok: true, detalle: null }
      : { ok: false, motivo: 'este tipo de documento no lleva detalle' };
  }
  if (vacio || typeof detalle !== 'object' || Array.isArray(detalle)) {
    return {
      ok: false,
      motivo: `falta el detalle: ${campos.map((c) => c.clave).join(', ')}`,
    };
  }

  const entrada = detalle as Record<string, unknown>;
  const limpio: DetalleDeDocumento = {};
  for (const campo of campos) {
    const valor = entrada[campo.clave];
    const texto = typeof valor === 'string' ? valor.trim() : '';
    if (texto === '') {
      return {
        ok: false,
        motivo: `detalle.${campo.clave} (${campo.etiqueta}) es obligatorio`,
      };
    }
    if (texto.length > campo.maximo) {
      return {
        ok: false,
        motivo: `detalle.${campo.clave} (${campo.etiqueta}) admite hasta ${campo.maximo} caracteres`,
      };
    }
    if (campo.fecha && !esDiaReal(texto)) {
      return {
        ok: false,
        motivo: `detalle.${campo.clave} (${campo.etiqueta}) tiene que ser una fecha real YYYY-MM-DD`,
      };
    }
    limpio[campo.clave] = texto;
  }

  const permitidas = new Set(campos.map((c) => c.clave));
  const sobrante = Object.keys(entrada).find((k) => !permitidas.has(k));
  if (sobrante) {
    return {
      ok: false,
      motivo: `detalle.${sobrante} no corresponde a este tipo de documento`,
    };
  }
  return { ok: true, detalle: limpio };
}
