import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ChequeosService } from './chequeos.service';
import { COMPONENTES, Componente } from './componentes';
import { inicioDeBloque } from './disponibilidad';
import { HistorialStore } from './historial.store';

/** Tope de muestras que esperan en memoria mientras Redis está caído (~1 día). */
const MAX_PENDIENTES = 288;

/** Cada cuánto se mira si empezó un bloque nuevo. */
const LATIDO_MS = 60_000;

type Muestra = Record<Componente, boolean>;

/**
 * Muestrea el estado de cada componente cada 5 minutos y lo guarda en el
 * historial de la página de estado. Nunca lanza: un muestreo fallido no puede
 * tumbar el cron ni la app.
 */
@Injectable()
export class MuestreoEstadoService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('MuestreoEstado');
  /** Muestras que no se pudieron escribir (Redis caído), por bloque. */
  private readonly pendientes = new Map<number, Muestra>();
  private ultimoBloque: number | null = null;
  private temporizador: NodeJS.Timeout | null = null;

  constructor(
    private readonly chequeos: ChequeosService,
    private readonly store: HistorialStore,
  ) {}

  /**
   * Una muestra al arrancar (un reinicio corto no deja un hueco de 5 minutos)
   * y un latido por minuto: `muestrear` toma la muestra la primera vez que ve
   * un bloque nuevo y descarta el resto, así el ritmo no se corre con el
   * tiempo. No es un `@Cron`: el catálogo de procesos (`ProcessName`) es de
   * las tareas de negocio y exige migración; esto es una sonda de la propia API.
   */
  async onApplicationBootstrap(): Promise<void> {
    this.temporizador = setInterval(() => void this.muestrear(), LATIDO_MS);
    this.temporizador.unref();
    await this.muestrear();
  }

  onApplicationShutdown(): void {
    if (this.temporizador) clearInterval(this.temporizador);
    this.temporizador = null;
  }

  async muestrear(ahora: number = Date.now()): Promise<void> {
    try {
      const bloque = inicioDeBloque(ahora);
      // Dos ticks seguidos en el mismo bloque no duplican la muestra (y si el
      // proceso se reinicia, `HSETNX` en el store conserva la primera).
      if (this.ultimoBloque === bloque) return;
      this.ultimoBloque = bloque;

      const estados = await this.chequeos.estados();
      const muestra = {} as Muestra;
      for (const c of COMPONENTES) muestra[c] = estados[c] === 'up';

      await this.escribir(bloque, muestra);
    } catch (error) {
      this.logger.warn(
        `No se pudo muestrear el estado: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async escribir(bloque: number, muestra: Muestra): Promise<void> {
    // Primero lo que quedó pendiente (en orden), después la muestra de ahora.
    const cola: Array<[number, Muestra]> = [
      ...this.pendientes.entries(),
      [bloque, muestra],
    ];
    let redisCaido = false;
    for (const [inicio, valores] of cola) {
      if (!redisCaido) {
        try {
          await this.store.registrar(inicio, valores);
          this.pendientes.delete(inicio);
          continue;
        } catch {
          redisCaido = true;
        }
      }
      // Redis caído: su muestra cuenta como caída y no se escribe ahora; la
      // de los demás componentes espera en memoria y se guarda cuando vuelva.
      this.pendientes.set(inicio, { ...valores, redis: false });
    }
    while (this.pendientes.size > MAX_PENDIENTES) {
      const masVieja = this.pendientes.keys().next().value as number;
      this.pendientes.delete(masVieja);
    }
  }
}
