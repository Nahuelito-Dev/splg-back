import {
  Inject,
  Injectable,
  Logger,
  Optional,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { redisConnectionOptions } from '../common/redis/redis-connection';
import { COMPONENTES, Componente } from './componentes';
import {
  BLOQUES_POR_DIA,
  DIAS_HISTORIAL,
  Muestras,
  bloqueDelDia,
  campoDeMuestra,
  claveDeDia,
} from './disponibilidad';

/** Se guarda un poco más que los 90 días que se muestran. */
/** Token para inyectar otro cliente (los tests usan uno en memoria). */
export const CLIENTE_HISTORIAL = Symbol('CLIENTE_HISTORIAL');
export type ClienteHistorial = Pick<Redis, 'pipeline' | 'disconnect' | 'on'>;

export const VIGENCIA_SEG = 95 * 24 * 60 * 60;
const DIA_MS = 24 * 60 * 60_000;
const CLAVE_PRIMERA = 'health:historial:primera';
const clavePorDia = (dia: string) => `health:historial:${dia}`;

export interface HistorialLeido {
  /** Inicio del bloque de la primera muestra registrada (`null` si no hay). */
  primeraMuestra: number | null;
  muestras: Muestras;
}

/** Dónde se guarda el historial; en producción es Redis. */
export abstract class HistorialStore {
  /** Guarda la muestra de un bloque. La primera de cada bloque gana. */
  abstract registrar(
    inicioDeBloque: number,
    estados: Record<Componente, boolean>,
  ): Promise<void>;
  abstract leer(ahora: number, dias?: number): Promise<HistorialLeido>;
}

/**
 * Un hash por día (`health:historial:<YYYY-MM-DD>`) con un campo por
 * componente y bloque de 5 minutos. `HSETNX` hace que dos muestras del mismo
 * bloque no se pisen ni se dupliquen. Usa su propio cliente: si Redis cae, las
 * escrituras fallan rápido (timeout) y el que llama decide qué hacer.
 */
@Injectable()
export class HistorialRedisStore
  extends HistorialStore
  implements OnApplicationShutdown
{
  private readonly logger = new Logger('HistorialEstado');
  private readonly client: ClienteHistorial;

  constructor(
    @Optional() @Inject(CLIENTE_HISTORIAL) cliente?: ClienteHistorial,
  ) {
    super();
    this.client =
      cliente ??
      new Redis({
        ...redisConnectionOptions(),
        commandTimeout: 3000,
        maxRetriesPerRequest: 1,
      });
    // Sin oyente, ioredis tira cada error de conexión como excepción sin atrapar.
    this.client.on('error', () => undefined);
  }

  async onApplicationShutdown(): Promise<void> {
    this.client.disconnect();
    await Promise.resolve();
  }

  async registrar(
    inicioDeBloque: number,
    estados: Record<Componente, boolean>,
  ): Promise<void> {
    const clave = clavePorDia(claveDeDia(inicioDeBloque));
    const bloque = bloqueDelDia(inicioDeBloque);
    const pipeline = this.client.pipeline();
    for (const componente of COMPONENTES) {
      pipeline.hsetnx(
        clave,
        campoDeMuestra(componente, bloque),
        estados[componente] ? '1' : '0',
      );
    }
    pipeline.expire(clave, VIGENCIA_SEG);
    pipeline.set(CLAVE_PRIMERA, String(inicioDeBloque), 'NX');
    const respuestas = await pipeline.exec();
    const fallo = respuestas?.find(([error]) => error)?.[0];
    if (fallo) throw fallo;
  }

  async leer(ahora: number, dias = DIAS_HISTORIAL): Promise<HistorialLeido> {
    const claves: string[] = [];
    for (let i = dias - 1; i >= 0; i--)
      claves.push(claveDeDia(ahora - i * DIA_MS));
    const pipeline = this.client.pipeline();
    pipeline.get(CLAVE_PRIMERA);
    for (const dia of claves) pipeline.hgetall(clavePorDia(dia));
    const respuestas = await pipeline.exec();
    if (!respuestas) throw new Error('Sin respuesta de Redis');
    const fallo = respuestas.find(([error]) => error)?.[0];
    if (fallo) throw fallo;

    const primera = respuestas[0][1] as string | null;
    const muestras = new Map<string, Map<string, boolean>>();
    claves.forEach((dia, i) => {
      const hash = (respuestas[i + 1][1] ?? {}) as Record<string, string>;
      const delDia = new Map<string, boolean>();
      for (const [campo, valor] of Object.entries(hash)) {
        delDia.set(campo, valor === '1');
      }
      muestras.set(dia, delDia);
    });
    return {
      primeraMuestra: primera === null ? null : Number(primera),
      muestras,
    };
  }

  /** Para diagnóstico: cuántos campos entran en un día completo. */
  static readonly CAMPOS_POR_DIA = COMPONENTES.length * BLOQUES_POR_DIA;
}
