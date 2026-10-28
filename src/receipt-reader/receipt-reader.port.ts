/**
 * PUERTO del lector de comprobantes de pago. Recibe el archivo que subió el
 * admin (PDF o foto) y devuelve lo que pudo leer para PRECARGAR el formulario:
 * nada de lo que devuelve se guarda sin que el admin lo confirme.
 *
 * Mientras no haya un lector configurado se usa `LectorDeComprobantesNulo`
 * (`disponible = false`, `leer` devuelve null) y el admin carga los datos a mano.
 */

export interface ArchivoDeComprobante {
  buffer: Buffer;
  /** `application/pdf`, `image/jpeg`, `image/png` o `image/webp`. */
  mimeType: string;
}

/** Lo que el sistema ya espera, para que el lector marque diferencias. */
export interface PistasDelComprobante {
  expectedAmount?: string;
  payee?: string;
}

export interface DatosDelComprobante {
  /** Importe pagado como decimal en texto (`"38390.00"`), o null si no se leyó. */
  amount: string | null;
  /** Fecha y hora del pago en ISO 8601, o null. */
  paidAt: string | null;
  operationNumber: string | null;
  /** A quién se le pagó (aseguradora, municipio...). */
  payee: string | null;
  payeeTaxId: string | null;
  /** Período que cubre, ej.: `2026-11`, o null. */
  period: string | null;
  confidence: 'high' | 'medium' | 'low';
  /** Avisos para el admin, ej.: «el importe no coincide con la cuota». */
  warnings: string[];
}

export abstract class ReceiptReaderPort {
  abstract readonly disponible: boolean;
  abstract leer(
    archivo: ArchivoDeComprobante,
    pistas?: PistasDelComprobante,
  ): Promise<DatosDelComprobante | null>;
}
