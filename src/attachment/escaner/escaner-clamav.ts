import { createConnection } from 'net';
import {
  EscanerDeArchivos,
  ResultadoDelEscaneo,
} from './escaner-de-archivos.port';

export interface OpcionesDeClamAv {
  host: string;
  port: number;
  /** Tope de toda la conversación con `clamd` (conectar, mandar, esperar el veredicto). */
  timeoutMs: number;
}

/** Tamaño de cada trozo del `INSTREAM` (el de omisión de `clamdscan`). */
const TROZO = 64 * 1024;

/**
 * Lee la respuesta de `clamd` a `zINSTREAM`: `stream: OK`, `stream: <firma>
 * FOUND` o un error (`INSTREAM size limit exceeded. ERROR`, …), que se lanza.
 */
export function interpretarRespuestaDeClamAv(
  respuesta: string,
): ResultadoDelEscaneo {
  const texto = respuesta.replace(/\0/g, '').trim();
  if (/^stream: OK$/.test(texto)) return { infectado: false };
  const encontrado = /^stream: (.+) FOUND$/.exec(texto);
  if (encontrado) return { infectado: true, firma: encontrado[1] };
  throw new Error(`ClamAV respondió algo que no se entiende: «${texto}»`);
}

/**
 * ClamAV por TCP con el protocolo `INSTREAM` de `clamd`: `zINSTREAM\0`, el
 * archivo en trozos (cada uno con su largo de 4 bytes big-endian) y un trozo
 * de largo 0 para terminar; `clamd` responde una línea y cierra.
 */
export class EscanerClamAv extends EscanerDeArchivos {
  readonly nombre = 'ClamAV';

  constructor(private readonly opciones: OpcionesDeClamAv) {
    super();
  }

  escanear(contenido: Buffer): Promise<ResultadoDelEscaneo> {
    const { host, port, timeoutMs } = this.opciones;
    return new Promise<ResultadoDelEscaneo>((resolver, rechazar) => {
      const partes: Buffer[] = [];
      let terminado = false;
      const socket = createConnection({ host, port });
      const terminar = (error: Error | null, r?: ResultadoDelEscaneo) => {
        if (terminado) return;
        terminado = true;
        clearTimeout(reloj);
        socket.destroy();
        if (error) rechazar(error);
        else resolver(r as ResultadoDelEscaneo);
      };
      const reloj = setTimeout(
        () =>
          terminar(
            new Error(`ClamAV no respondió en ${timeoutMs / 1000} segundos`),
          ),
        timeoutMs,
      );
      socket.on('error', (e) => terminar(e));
      socket.on('data', (d: Buffer) => partes.push(d));
      socket.on('end', () => {
        try {
          terminar(
            null,
            interpretarRespuestaDeClamAv(Buffer.concat(partes).toString()),
          );
        } catch (e) {
          terminar(e as Error);
        }
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < contenido.length; i += TROZO) {
          const trozo = contenido.subarray(i, i + TROZO);
          const largo = Buffer.alloc(4);
          largo.writeUInt32BE(trozo.length);
          socket.write(largo);
          socket.write(trozo);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}
