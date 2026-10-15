import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { ModuleConfigService } from './module-config.service';
import { ConfigurableProcess } from './entities/module-config.entity';
import {
  ScheduledTasksSettings,
  TareaConIntervalo,
  TIC_SEGUNDOS,
  scheduledTasksDesde,
  scheduledTasksPorDefecto,
  sonLosDeOmision,
} from './scheduled-tasks-settings';

/** Lo que devuelve la API: la frecuencia vigente y quién la modificó. */
export interface ScheduledTasksVigentes extends ScheduledTasksSettings {
  isDefault: boolean;
  updatedAt: Date | null;
  updatedByUserId: string | null;
}

interface EntradaDeCache {
  settings: ScheduledTasksSettings;
  /** Generación de la configuración con que se cargó (ver `claveDeGeneracion`). */
  generacion: string;
  venceEn: number;
}

/**
 * Frecuencia de las tareas programadas por distribuidora (CU-173), guardada en
 * `module_config` (proceso `scheduled_tasks`).
 *
 * El `@Cron` no admite una expresión distinta por distribuidora: cada tarea
 * conserva su tic fijo y, al empezar cada tic, pide con `distribuidorasQueCorren`
 * el conjunto de distribuidoras a las que les toca. La marca de última
 * ejecución vive en Redis (una por distribuidora y tarea) y vence sola al
 * cumplirse el intervalo; con varias instancias, el SET NX decide una sola.
 *
 * Generación: cada `PUT` incrementa `scheduled-task:gen:<distribuidora>` y la
 * clave de la marca la incluye. Así una marca nunca sobrevive a un cambio de
 * configuración: ni la que otra instancia (con la copia en memoria vieja) o un
 * tic en curso creen después del `PUT`, porque quedan bajo una generación que
 * ya no se consulta. Y cada lectura compara la generación de Redis con la de la
 * copia en memoria: si difiere, la descarta y relee la configuración.
 */
@Injectable()
export class ScheduledTasksSettingsService {
  static readonly CACHE_TTL_MS = 60_000;

  private readonly cache = new Map<string, EntradaDeCache>();

  constructor(
    private readonly configs: ModuleConfigService,
    private readonly redis: RedisService,
  ) {}

  /** Los parámetros que rigen (con copia en memoria de un minuto, validada por generación). */
  async obtener(
    distributorId: string | null | undefined,
  ): Promise<ScheduledTasksSettings> {
    if (!distributorId) return scheduledTasksPorDefecto();
    return (await this.cargar(distributorId)).settings;
  }

  /** Lo configurado en la base, sin la copia en memoria (lo que muestra el panel). */
  async vigentes(distributorId: string): Promise<ScheduledTasksVigentes> {
    const fila = await this.configs.fila(
      distributorId,
      ConfigurableProcess.SCHEDULED_TASKS,
    );
    const settings = scheduledTasksDesde(fila?.params ?? null);
    return {
      ...settings,
      isDefault: sonLosDeOmision(settings),
      updatedAt: fila?.updatedAt ?? null,
      updatedByUserId: fila?.updatedByUserId ?? null,
    };
  }

  /**
   * Guarda sólo lo que vino (lo demás se lee con su valor por omisión), sube la
   * generación y borra las marcas de la generación anterior: los intervalos
   * nuevos rigen desde el ciclo siguiente.
   */
  async guardar(
    distributorId: string,
    settings: Partial<ScheduledTasksSettings>,
    actorUserId: string,
  ): Promise<ScheduledTasksVigentes> {
    const enviados = Object.fromEntries(
      Object.entries(settings).filter(([, valor]) => valor != null),
    );
    await this.configs.guardar(
      distributorId,
      ConfigurableProcess.SCHEDULED_TASKS,
      enviados,
      actorUserId,
    );
    const nueva = await this.redis.incr(this.claveDeGeneracion(distributorId));
    this.cache.delete(distributorId);
    for (const tarea of Object.keys(TIC_SEGUNDOS) as TareaConIntervalo[]) {
      await this.redis.del(
        this.claveDeMarca(tarea, distributorId, String(nueva - 1)),
      );
    }
    return this.vigentes(distributorId);
  }

  /**
   * Al empezar un tic: de las distribuidoras con trabajo (`ids`), las que
   * corren ahora. Deja la marca de cada una en este momento, en una sola
   * pasada, antes de procesar nada. Con el intervalo igual al tic corre siempre
   * y no hay marca.
   *
   * La marca vence medio tic antes del intervalo, no justo en él: el reloj del
   * cron tiene jitter y, si la marca durara el intervalo exacto, un tic que
   * llega unos milisegundos antes la encontraría viva y la distribuidora
   * correría un tic tarde.
   */
  async distribuidorasQueCorren(
    tarea: TareaConIntervalo,
    ids: readonly string[],
  ): Promise<Set<string>> {
    const corren = new Set<string>();
    for (const id of new Set(ids)) {
      if (await this.leTocaCorrer(tarea, id)) corren.add(id);
    }
    return corren;
  }

  /**
   * Devuelve el intervalo entero a una distribuidora cuyo tic falló antes de
   * procesarla: borra su marca para que no pierda un intervalo completo.
   */
  async liberarMarca(
    tarea: TareaConIntervalo,
    distributorId: string,
  ): Promise<void> {
    const generacion = await this.generacionVigente(distributorId);
    await this.redis.del(this.claveDeMarca(tarea, distributorId, generacion));
  }

  /** ¿Es la hora del aviso de flota de esta distribuidora? (el tic es de una hora). */
  async esLaHoraDelAvisoDeFlota(
    distributorId: string,
    horaActual: number,
  ): Promise<boolean> {
    return (await this.obtener(distributorId)).fleetAlertHour === horaActual;
  }

  private async leTocaCorrer(
    tarea: TareaConIntervalo,
    distributorId: string,
  ): Promise<boolean> {
    const { settings, generacion } = await this.cargar(distributorId);
    const intervalo = settings[tarea];
    const tic = TIC_SEGUNDOS[tarea];
    if (intervalo <= tic) return true;
    return this.redis.setIfAbsentMs(
      this.claveDeMarca(tarea, distributorId, generacion),
      intervalo * 1000 - (tic * 1000) / 2,
    );
  }

  private async cargar(
    distributorId: string,
  ): Promise<{ settings: ScheduledTasksSettings; generacion: string }> {
    // La generación se lee ANTES que la configuración: si un PUT cae en el
    // medio, lo cargado queda con la generación vieja y se relee en la próxima.
    const generacion = await this.generacionVigente(distributorId);
    const guardada = this.cache.get(distributorId);
    if (
      guardada &&
      guardada.generacion === generacion &&
      guardada.venceEn > Date.now()
    ) {
      return { settings: { ...guardada.settings }, generacion };
    }
    const params = await this.configs.parametros(
      distributorId,
      ConfigurableProcess.SCHEDULED_TASKS,
    );
    const settings = scheduledTasksDesde(params);
    this.cache.set(distributorId, {
      settings,
      generacion,
      venceEn: Date.now() + ScheduledTasksSettingsService.CACHE_TTL_MS,
    });
    return { settings: { ...settings }, generacion };
  }

  private async generacionVigente(distributorId: string): Promise<string> {
    return (await this.redis.get(this.claveDeGeneracion(distributorId))) ?? '0';
  }

  private claveDeGeneracion(distributorId: string) {
    return `scheduled-task:gen:${distributorId}`;
  }

  private claveDeMarca(
    tarea: TareaConIntervalo,
    distributorId: string,
    generacion: string,
  ) {
    return `scheduled-task:${tarea}:${distributorId}:${generacion}`;
  }
}
