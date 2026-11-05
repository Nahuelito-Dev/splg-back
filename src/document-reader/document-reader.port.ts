import { TipoDeDocumento } from './tipos-de-documento';

/**
 * PUERTO del lector de documentos (módulo M6). Recibe un PDF o una foto y
 * devuelve lo que pudo leer: el tipo de documento, cada campo con su nivel de
 * confianza y los avisos. Nada de lo que devuelve se registra sin que una
 * persona lo confirme.
 *
 * Sin lector configurado se usa `LectorDeDocumentosNulo` (`disponible = false`).
 */

export interface ArchivoDeDocumento {
  buffer: Buffer;
  /** `application/pdf`, `image/jpeg`, `image/png` o `image/webp`. */
  mimeType: string;
}

export type NivelDeConfianza = 'alta' | 'media' | 'baja';

export interface CampoLeido {
  /** Nombre del campo del catálogo (`importe`, `vencimiento`, `patente`...). */
  nombre: string;
  /** Valor normalizado (fechas ISO, importes con punto decimal), o null. */
  valor: string | null;
  confianza: NivelDeConfianza;
}

/** Una corrección anterior del administrador, para leer mejor la próxima vez. */
export interface EjemploDeCorreccion {
  campo: string;
  leido: string | null;
  correcto: string;
}

export interface OpcionesDeLectura {
  /** Si el sistema ya sabe qué documento es (p. ej. el comprobante de una cuota). */
  tipoEsperado?: TipoDeDocumento;
  /** Lo que el sistema espera encontrar, para que el lector marque diferencias. */
  pistas?: Record<string, string>;
  /** Correcciones anteriores para este tipo de documento y este emisor. */
  ejemplos?: EjemploDeCorreccion[];
}

export interface UsoDeLaLectura {
  /** Modelo que respondió (puede ser el de respaldo si el primero declinó). */
  modelo: string;
  tokensDeEntrada: number;
  tokensDeSalida: number;
  /** Costo estimado en dólares, con los precios de lista del modelo. */
  costoUsd: number;
}

export interface LecturaDeDocumento {
  tipo: TipoDeDocumento;
  /** false si el documento no se lee (borroso, cortado, en blanco). */
  legible: boolean;
  campos: CampoLeido[];
  /** Dudas y diferencias con lo esperado, en castellano. */
  avisos: string[];
  uso: UsoDeLaLectura;
}

export abstract class DocumentReaderPort {
  abstract readonly disponible: boolean;
  /** Devuelve null si el lector no está disponible o la lectura falló. */
  abstract leer(
    archivo: ArchivoDeDocumento,
    opciones?: OpcionesDeLectura,
  ): Promise<LecturaDeDocumento | null>;
}
