/** Lo que dice el escáner de un archivo. */
export type ResultadoDelEscaneo =
  | { infectado: false }
  | { infectado: true; firma: string };

/**
 * Puerto del antivirus (diseño de comunicación §9.3, D-C15). En producción,
 * ClamAV (`clamd` en un contenedor del despliegue, por TCP con `INSTREAM`);
 * sin `CLAMAV_HOST` (desarrollo: sólo base y Redis), el adaptador «sin
 * escaneo», que da todo por limpio. Un error (no responde, respuesta rara)
 * se lanza: quien escanea reintenta.
 */
export abstract class EscanerDeArchivos {
  /** Nombre para el log y el monitoreo. */
  abstract readonly nombre: string;
  abstract escanear(contenido: Buffer): Promise<ResultadoDelEscaneo>;
}
