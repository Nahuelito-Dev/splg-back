import {
  EscanerDeArchivos,
  ResultadoDelEscaneo,
} from './escaner-de-archivos.port';

/**
 * Adaptador sin antivirus: da todo por limpio. Es el de desarrollo (sin
 * contenedor de ClamAV). Las fotos no dependen de él: las limpia `sharp`.
 */
export class SinEscaneo extends EscanerDeArchivos {
  readonly nombre = 'sin escaneo';

  escanear(): Promise<ResultadoDelEscaneo> {
    return Promise.resolve({ infectado: false });
  }
}
