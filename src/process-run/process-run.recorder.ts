import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { hostname } from 'os';
import { Repository } from 'typeorm';
import { errorMessage } from '../common/errors/error-message';
import { ContextoDeTraza, type Traza } from '../common/traza/contexto-de-traza';
import { huellaDeError } from '../observability/errores/huella-de-error';
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
import { RachasDeFallas, type ResultadoDeRachas } from './rachas-de-fallas';

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

/** Lo que se guarda al abrir una corrida. */
interface Apertura {
  runId: string;
  proceso: ProcessName;
  distributorId: string | null;
  inicio: Date;
  disparo: RunTrigger;
  traceId: string;
  requestedBy: string | null;
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
 * Suma al cierre los elementos que vienen fallando hace varias corridas
 * (`persistentFailures`): la corrida ya es `partial` por sus errores, el
 * contador dice cuántos de esos son persistentes.
 */
export function conPersistentes(
  cierre: CierreDeCorrida,
  rachas: ResultadoDeRachas,
): CierreDeCorrida {
  if (rachas.persistentes === 0) return cierre;
  return {
    ...cierre,
    counters: { ...cierre.counters, persistentFailures: rachas.persistentes },
  };
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

  /**
   * Corre `fn` registrando la corrida. La corrida abre su traza
   * (`ContextoDeTraza`): hereda la del request que la disparó (webhook, pedido
   * manual) o, si nace del cron, usa su propio `run_id`. Todo lo que pase
   * adentro (log, avisos, auditoría) lleva ese `traceId`.
   *
   * Una corrida disparada desde un request se registra siempre, aun en los
   * procesos con muestreo: es la que alguien va a buscar por su traza.
   */
  async ejecutar<T>(
    proceso: ProcessName,
    distributorId: string | null,
    fn: () => Promise<T>,
    disparo: RunTrigger = disparoActual(),
    requestedBy: string | null = null,
  ): Promise<T> {
    const clave = `${proceso}:${distributorId ?? ''}:${disparo}`;
    const cadaMs = (CATALOGO[proceso].recordEverySeconds ?? 0) * 1000;
    const inicio = new Date();
    const ultima = this.ultimaApertura.get(clave);
    const estado = nuevaCorrida(proceso, distributorId);
    const heredada = ContextoDeTraza.actual();
    const runId = randomUUID();
    const traza: Traza = {
      traceId: heredada?.traceId ?? runId,
      origen: disparo,
      requestId: heredada?.requestId,
      runId,
    };
    const apertura: Apertura = {
      runId,
      proceso,
      distributorId,
      inicio,
      disparo,
      traceId: traza.traceId,
      requestedBy: disparo === RunTrigger.MANUAL ? requestedBy : null,
    };
    const correr = () =>
      ContextoDeTraza.abrir(traza, () => dentroDeCorrida(estado, fn));
    if (
      !heredada &&
      cadaMs > 0 &&
      ultima !== undefined &&
      inicio.getTime() - ultima < cadaMs
    ) {
      // Proceso de alta frecuencia: no se registra cada tic, pero un error sí
      // (y las rachas de fallas por elemento se siguen igual).
      try {
        const valor = await correr();
        await this.rachas(proceso, distributorId, estado);
        if (estado.fatal) {
          await this.registrarFalloSuelto(clave, apertura, estado.fatal);
        }
        return valor;
      } catch (error) {
        await this.rachas(proceso, distributorId, estado);
        await this.registrarFalloSuelto(clave, apertura, error);
        throw error;
      }
    }
    this.ultimaApertura.set(clave, inicio.getTime());

    const registrada = await this.abrir(apertura);
    try {
      const valor = await correr();
      const cierre = conPersistentes(
        resolverCierre(valor, estado),
        await this.rachas(proceso, distributorId, estado),
      );
      await this.cerrar(registrada, proceso, cierre, estado.companies);
      if (cierre.status === ProcessRunStatus.SKIPPED && cadaMs > 0) {
        await this.soltarMuestreo(clave, ultima, registrada, inicio, cadaMs);
      }
      return valor;
    } catch (error) {
      await this.rachas(proceso, distributorId, estado);
      await this.cerrar(
        registrada,
        proceso,
        {
          status: ProcessRunStatus.FAILED,
          counters: {},
          error: sanitizarError(errorMessage(error)),
        },
        estado.companies,
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

  /** Las rachas de fallas por elemento (nunca tira: `RachasDeFallas` atrapa lo suyo). */
  private rachas(
    proceso: ProcessName,
    distributorId: string | null,
    estado: CorridaEnCurso,
  ): Promise<ResultadoDeRachas> {
    const rachas = RachasDeFallas.instalada();
    return rachas
      ? rachas.seguir(proceso, distributorId, estado)
      : Promise.resolve({ persistentes: 0, avisados: 0 });
  }

  private async abrir(apertura: Apertura): Promise<string | null> {
    try {
      await this.runs
        .createQueryBuilder()
        .insert()
        .values({
          runId: apertura.runId,
          process: apertura.proceso,
          distributorId: apertura.distributorId,
          startedAt: apertura.inicio,
          status: ProcessRunStatus.RUNNING,
          counters: {},
          trigger: apertura.disparo,
          instance: this.instance,
          traceId: apertura.traceId,
          requestedBy: apertura.requestedBy,
        })
        .execute();
      return apertura.runId;
    } catch (error) {
      // No poder registrar no es un detalle: la pantalla diría que todo anda bien.
      this.logger.error(
        `No se pudo abrir el registro de ${apertura.proceso}: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private async cerrar(
    runId: string | null,
    proceso: ProcessName,
    cierre: CierreDeCorrida,
    companies: Record<string, number> | null,
  ): Promise<void> {
    if (!runId) return;
    try {
      await this.runs
        .createQueryBuilder()
        .update()
        .set({
          status: cierre.status,
          counters: cierre.counters,
          error: cierre.error,
          errorFingerprint: cierre.error
            ? huellaDeError({
                origen: 'process',
                donde: proceso,
                mensaje: cierre.error,
              })
            : null,
          companies,
          finishedAt: () => 'GREATEST(now(), "started_at")',
        })
        .where('run_id = :runId', { runId })
        .execute();
    } catch (e) {
      this.logger.error(
        `No se pudo cerrar el registro ${runId}: ${errorMessage(e)}`,
      );
    }
  }

  private async registrarFalloSuelto(
    clave: string,
    apertura: Apertura,
    error: unknown,
  ): Promise<void> {
    const cadaMs = (CATALOGO[apertura.proceso].recordEverySeconds ?? 0) * 1000;
    const previo = this.ultimoFallo.get(clave);
    if (previo !== undefined && apertura.inicio.getTime() - previo < cadaMs) {
      return;
    }
    this.ultimoFallo.set(clave, apertura.inicio.getTime());
    const runId = await this.abrir(apertura);
    await this.cerrar(
      runId,
      apertura.proceso,
      {
        status: ProcessRunStatus.FAILED,
        counters: {},
        error: sanitizarError(errorMessage(error)),
      },
      null,
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
