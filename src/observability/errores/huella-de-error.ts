import { createHash } from 'node:crypto';

/** De dónde salió el error: un request HTTP o una corrida de proceso. */
export type OrigenDelError = 'http' | 'process';

export interface DatosDeLaHuella {
  origen: OrigenDelError;
  /** La ruta patrón (`PATCH /v2/orders/:id`) o el nombre del proceso. */
  donde: string;
  /** Nombre de la excepción (`QueryFailedError`); vacío si no se conoce. */
  nombre?: string | null;
  /** Primer frame propio del stack, sin número de línea; vacío si no se conoce. */
  frame?: string | null;
  mensaje: string;
}

const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const FECHA_ISO =
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
const HEXA_LARGO = /\b[0-9a-f]{16,}\b/gi;
const NUMERO = /\d+(?:[.,]\d+)?/g;
const ENTRE_COMILLAS = /(["'«`])(?:(?!\1).)*(\1|»)/g;

/**
 * El mensaje sin lo que cambia de una ocurrencia a otra (ids, fechas, números,
 * textos entre comillas): dos fallas iguales sobre datos distintos dan lo mismo.
 */
export function normalizarMensaje(mensaje: string): string {
  return mensaje
    .replace(UUID, '<id>')
    .replace(FECHA_ISO, '<fecha>')
    .replace(HEXA_LARGO, '<hex>')
    .replace(ENTRE_COMILLAS, '<texto>')
    .replace(NUMERO, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * La huella de un error (DISENO-OBSERVABILIDAD §5.5): los 16 primeros
 * hexadecimales del SHA-256 de `nombre | origen | dónde | frame | mensaje
 * normalizado`. Estable entre ocurrencias del mismo error y distinta entre
 * errores de otra ruta o proceso. Agrupa los errores en `api_error_group` (O6).
 */
export function huellaDeError(datos: DatosDeLaHuella): string {
  const partes = [
    datos.nombre ?? '',
    datos.origen,
    datos.donde,
    datos.frame ?? '',
    normalizarMensaje(datos.mensaje),
  ];
  return createHash('sha256')
    .update(partes.join('|'))
    .digest('hex')
    .slice(0, 16);
}
