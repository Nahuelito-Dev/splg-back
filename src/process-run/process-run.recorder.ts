import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { hostname } from 'os';
import { Repository } from 'typeorm';
import { errorMessage } from '../common/errors/error-message';
import {
  CATALOGO,
  ProcessName,
  ProcessRunStatus,
  RunTrigger,
} from './domain/process-catalog';
import {
  dentroDeCorrida,
  disparoActual,
  nuevaCorrida,
  type CorridaEnCurso,
} from './process-run.context';
import { sanitizarError } from './domain/sanitizar-error';
import { ProcessRun } from './entities/process-run.entity';

export interface ResultadoDeCorrida {
  counters: Record<string, number>;
  status: ProcessRunStatus.OK | ProcessRunStatus.PARTIAL;
}

/** Nombres de contador que, si valen más de cero, dejan la corrida como `partial`. */
const CONTADORES_DE_ERROR: ReadonlySet<string> = new Set([
  'errors',
  'errores',
  'failed',
]);

/**
 * Lo que devuelve una corrida, hecho contadores: un número es `processed`; un
 * objeto aporta sus propiedades numéricas. Cualquier otra cosa no suma.
 */
export function resultadoDeCorrida(valor: unknown): ResultadoDeCorrida {
  const counters: Record<string, number> = {};
  if (typeof valor === 'number' && Number.isFinite(valor)) {
    counters.processed = valor;
  } else if (typeof valor === 'object' && valor !== null) {
    for (const [k, v] of Object.entries(valor)) {
      if (typeof v === 'number' && Number.isFinite(v)) counters[k] = v;
    }
  }
  const conErrores = Object.entries(counters).some(
    ([k, v]) => CONTADORES_DE_ERROR.has(k) && v > 0,
  );
  return {
    counters,
    status: conErrores ? ProcessRunStatus.PARTIAL : ProcessRunStatus.OK,
  };
}

export interface CierreDeCorrida {
  status: ProcessRunStatus;
  counters: Record<string, number>;
  error: string | null;
}

/**
 * Cómo termina una corrida que no lanzó: lo que devolvió, más lo que el propio
 * proceso avisó (`saltada` por cerrojo, errores atrapados).
 */
export function resolverCierre(
  valor: unknown,
  estado: CorridaEnCurso,
): CierreDeCorrida {
  if (estado.skipped) {
    return { status: ProcessRunStatus.SKIPPED, counters: {}, error: null };
  }
  const { counters, status } = resultadoDeCorrida(valor);
  if (estado.fatal) {
    return {
      status: ProcessRunStatus.FAILED,
      counters,
      error: sanitizarError(estado.fatal),
    };
  }
  if (estado.errors > 0) {
    return {
      status: ProcessRunStatus.PARTIAL,
      counters: {
        ...counters,
        errors: Math.max(counters.errors ?? 0, estado.errors),
      },
      error: estado.lastError ? sanitizarError(estado.lastError) : null,
    };
  }
  return { status, counters, error: null };
}

/**
 * El registrador único de corridas (F31). Envuelve la ejecución de un proceso
 * sin cambiar su lógica ni su resultado: lo que el proceso devuelve o lanza
 * sale igual. Si el propio registro falla (base caída, tabla sin migrar) se
 * deja en el log y el proceso sigue como si nada.
 */
@Injectable()
export class ProcessRunRecorder implements OnModuleInit {
  /** La instancia viva, para que `@ConRegistro` llegue sin tocar constructores. */
  private static activo: ProcessRunRecorder | null = null;

  private readonly logger = new Logger(ProcessRunRecorder.name);
  private readonly instance = `${hostname()}:${process.pid}`.slice(0, 120);
  private readonly ultimaApertura = new Map<string, number>();
  private readonly ultimoFallo = new Map<string, number>();
  private readonly ultimaSaltada = new Map<string, number>();

  constructor(
    @InjectRepository(ProcessRun)
    private readonly runs: Repository<ProcessRun>,
  ) {}

  static instalado(): ProcessRunRecorder | null {
    return ProcessRunRecorder.activo;
  }

  /** Sólo para pruebas: deja el registrador como estaba. */
  static desinstalar(): void {
    ProcessRunRecorder.activo = null;
  }

  onModuleInit(): void {
    ProcessRunRecorder.activo = this;
  }

  async ejecutar<T>(
    proceso: ProcessName,
    distributorId: string | null,
    fn: () => Promise<T>,
    disparo: RunTrigger = disparoActual(),
  ): Promise<T> {
    const clave = `${proceso}:${distributorId ?? ''}:${disparo}`;
    const cadaMs = (CATALOGO[proceso].recordEverySeconds ?? 0) * 1000;
    const inicio = new Date();
    const ultima = this.ultimaApertura.get(clave);
    const estado = nuevaCorrida();
    if (
      cadaMs > 0 &&
      ultima !== undefined &&
      inicio.getTime() - ultima < cadaMs
    ) {
      // Proceso de alta frecuencia: no se registra cada tic, pero un error sí.
      try {
        const valor = await dentroDeCorrida(estado, fn);
        if (estado.fatal) {
          await this.registrarFalloSuelto(
            clave,
            proceso,
            distributorId,
            inicio,
            estado.fatal,
            disparo,
          );
        }
        return valor;
      } catch (error) {
        await this.registrarFalloSuelto(
          clave,
          proceso,
          distributorId,
          inicio,
          error,
          disparo,
        );
        throw error;
      }
    }
    this.ultimaApertura.set(clave, inicio.getTime());

    const runId = await this.abrir(proceso, distributorId, inicio, disparo);
    try {
      const valor = await dentroDeCorrida(estado, fn);
      const cierre = resolverCierre(valor, estado);
      await this.cerrar(runId, cierre.status, cierre.counters, cierre.error);
      if (cierre.status === ProcessRunStatus.SKIPPED && cadaMs > 0) {
        await this.soltarMuestreo(clave, ultima, runId, inicio, cadaMs);
      }
      return valor;
    } catch (error) {
      await this.cerrar(
        runId,
        ProcessRunStatus.FAILED,
        {},
        sanitizarError(errorMessage(error)),
      );
      throw error;
    }
  }

  /**
   * Un tic de alta frecuencia que salió salteado (otra instancia tenía el
   * cerrojo) no gasta la ventana de muestreo: el próximo que gane el cerrojo
   * tiene que poder registrarse, o el proceso se vería atrasado aunque corra en
   * todos los tics. Para no escribir una fila salteada por tic, de las
   * salteadas se conserva una por ventana.
   */
  private async soltarMuestreo(
    clave: string,
    ultima: number | undefined,
    runId: string | null,
    inicio: Date,
    cadaMs: number,
  ): Promise<void> {
    if (ultima === undefined) this.ultimaApertura.delete(clave);
    else this.ultimaApertura.set(clave, ultima);
    const previa = this.ultimaSaltada.get(clave);
    if (previa === undefined || inicio.getTime() - previa >= cadaMs) {
      this.ultimaSaltada.set(clave, inicio.getTime());
      return;
    }
    if (!runId) return;
    try {
      await this.runs
        .createQueryBuilder()
        .delete()
        .where('run_id = :runId', { runId })
        .execute();
    } catch (error) {
      this.logger.warn(
        `No se pudo descartar el registro salteado ${runId}: ${errorMessage(error)}`,
      );
    }
  }

  private async abrir(
    proceso: ProcessName,
    distributorId: string | null,
    inicio: Date,
    disparo: RunTrigger,
  ): Promise<string | null> {
    try {
      const { identifiers } = await this.runs
        .createQueryBuilder()
        .insert()
        .values({
          process: proceso,
          distributorId,
          startedAt: inicio,
          status: ProcessRunStatus.RUNNING,
          counters: {},
          trigger: disparo,
          instance: this.instance,
        })
        .execute();
      return (identifiers[0] as { runId: string }).runId;
    } catch (error) {
      this.logger.warn(
        `No se pudo abrir el registro de ${proceso}: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private async cerrar(
    runId: string | null,
    status: ProcessRunStatus,
    counters: Record<string, number>,
    error: string | null,
  ): Promise<void> {
    if (!runId) return;
    try {
      await this.runs
        .createQueryBuilder()
        .update()
        .set({
          status,
          counters,
          error,
          finishedAt: () => 'GREATEST(now(), "started_at")',
        })
        .where('run_id = :runId', { runId })
        .execute();
    } catch (e) {
      this.logger.warn(
        `No se pudo cerrar el registro ${runId}: ${errorMessage(e)}`,
      );
    }
  }

  private async registrarFalloSuelto(
    clave: string,
    proceso: ProcessName,
    distributorId: string | null,
    inicio: Date,
    error: unknown,
    disparo: RunTrigger,
  ): Promise<void> {
    const cadaMs = (CATALOGO[proceso].recordEverySeconds ?? 0) * 1000;
    const previo = this.ultimoFallo.get(clave);
    if (previo !== undefined && inicio.getTime() - previo < cadaMs) return;
    this.ultimoFallo.set(clave, inicio.getTime());
    const runId = await this.abrir(proceso, distributorId, inicio, disparo);
    await this.cerrar(
      runId,
      ProcessRunStatus.FAILED,
      {},
      sanitizarError(errorMessage(error)),
    );
  }
}

/**
 * Registra cada corrida del método como corrida global del proceso. Va debajo
 * de `@Cron(...)`. Sin registrador instalado (pruebas unitarias) llama al
 * método tal cual.
 */
export function ConRegistro(proceso: ProcessName): MethodDecorator {
  return (_objetivo, _nombre, descriptor) => {
    const original = descriptor.value as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    descriptor.value = function (this: unknown, ...args: unknown[]) {
      const registrador = ProcessRunRecorder.instalado();
      if (!registrador) return original.apply(this, args);
      return registrador.ejecutar(proceso, null, () =>
        original.apply(this, args),
      );
    } as unknown as typeof descriptor.value;
    return descriptor;
  };
}
