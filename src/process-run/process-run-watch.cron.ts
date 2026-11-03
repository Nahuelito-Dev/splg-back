import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { pedirAvisoAlAdmin } from '../common/events/aviso-al-admin';
import { diaArgentino, ZONA_ARGENTINA } from '../common/utils/dias-argentina';
import { DistributorService } from '../distributor/distributor.service';
import { DistributorStatus } from '../distributor/entities/distributor.entity';
import {
  CATALOGO,
  periodoEsperadoSeg,
  ProcessHealth,
  ProcessName,
  ProcessRunStatus,
} from './domain/process-catalog';
import { FACTOR_DE_ATRASO, SALUD_CON_ALERTA } from './domain/process-health';
import { ProcessRun } from './entities/process-run.entity';
import { ConRegistro } from './process-run.recorder';
import { ProcessRunService } from './process-run.service';

export const RETENCION_POR_DEFECTO_DIAS = 30;
/** Una corrida `running` más vieja que esto se cierra como fallida: el proceso murió sin terminarla. */
const ABANDONO_HORAS = 24;

const TEXTO: Partial<Record<ProcessHealth, string>> = {
  [ProcessHealth.LATE]: 'no corrió a tiempo',
  [ProcessHealth.FAILED]: 'terminó con error',
  [ProcessHealth.STUCK]: 'quedó trabado',
  [ProcessHealth.NEVER]: 'todavía no corrió',
};

/**
 * Vigila los procesos automáticos (F31): cada cinco minutos avisa a los
 * administradores de los que están atrasados, fallaron o quedaron colgados, y
 * una vez por día purga el historial viejo sin perder la última corrida de
 * cada proceso. El aviso no se repite en el día (dedupe por proceso, estado y día).
 */
@Injectable()
export class ProcessRunWatchCron {
  private readonly logger = new Logger(ProcessRunWatchCron.name);

  constructor(
    @InjectRepository(ProcessRun)
    private readonly runs: Repository<ProcessRun>,
    private readonly service: ProcessRunService,
    private readonly distributors: DistributorService,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

  @Cron('0 */5 * * * *')
  @ConRegistro(ProcessName.PROCESS_RUN_WATCH)
  async vigilar(
    ahora: Date = new Date(),
  ): Promise<{ alerts: number; closed: number }> {
    const closed = await this.cerrarAbandonadas(ahora);
    const estados = await this.service.estados(null, ahora);
    const activas = (await this.distributors.findAll()).filter(
      (d) => d.status === DistributorStatus.ACTIVE,
    );
    const dia = diaArgentino(ahora);
    const desde = await this.primeraCorrida();
    let alerts = 0;
    for (const e of estados) {
      // La vigilancia no se avisa a sí misma: si no corre, nadie la ve.
      if (e.proceso === ProcessName.PROCESS_RUN_WATCH) continue;
      if (!this.merecedoDeAviso(e.salud, e.proceso, desde, ahora)) continue;
      const titulo = CATALOGO[e.proceso].title;
      // Una corrida global es de la plataforma: a todas las empresas se les avisa con un texto
      // genérico, sin contadores ni error (ese detalle es sólo del administrador general, en el
      // tablero). La corrida de una empresa se avisa a esa empresa, con su detalle.
      const global = e.distributorId === null;
      const destinos = global
        ? activas
        : activas.filter((d) => d.distributorId === e.distributorId);
      const cuerpo = global
        ? `El proceso «${titulo}» ${TEXTO[e.salud]}. El equipo técnico ya fue avisado.`
        : `«${titulo}» ${TEXTO[e.salud]}.${e.ultima?.error ? ` Último error: ${e.ultima.error}` : ''}`;
      for (const d of destinos) {
        pedirAvisoAlAdmin(this.events, this.logger, {
          distributorId: d.distributorId,
          kind: 'process_run_alert',
          title: `Proceso automático: ${titulo}`,
          body: cuerpo,
          link: { entity: 'process-run', id: e.proceso },
          dedupeKey: `process-run:${e.proceso}:${e.salud}:${dia}`,
        });
        alerts += 1;
      }
    }
    return { alerts, closed };
  }

  /**
   * `failed`, `late` y `stuck` avisan siempre. `never` sólo cuando el monitoreo ya
   * lleva más de 1,5 períodos del proceso (si no, el primer día tras activarlo
   * avisaría de todos los procesos que todavía no les tocó correr).
   */
  private merecedoDeAviso(
    salud: ProcessHealth,
    proceso: ProcessName,
    desde: Date | null,
    ahora: Date,
  ): boolean {
    if (SALUD_CON_ALERTA.has(salud)) return true;
    if (salud !== ProcessHealth.NEVER || !desde) return false;
    return (
      ahora.getTime() - desde.getTime() >
      FACTOR_DE_ATRASO * periodoEsperadoSeg(proceso) * 1000
    );
  }

  /** La corrida más vieja que se conserva: desde cuándo se está monitoreando. */
  private async primeraCorrida(): Promise<Date | null> {
    const fila = await this.runs
      .createQueryBuilder('r')
      .select('MIN(r.startedAt)', 'desde')
      .getRawOne<{ desde: Date | null }>();
    return fila?.desde ? new Date(fila.desde) : null;
  }

  /** Las `running` de más de un día son de un proceso que murió: quedan como fallidas. */
  private async cerrarAbandonadas(ahora: Date): Promise<number> {
    const corte = new Date(ahora.getTime() - ABANDONO_HORAS * 3600_000);
    const r = await this.runs
      .createQueryBuilder()
      .update()
      .set({
        status: ProcessRunStatus.FAILED,
        error: 'El proceso se cortó sin terminar la corrida',
        finishedAt: () => 'GREATEST(now(), "started_at")',
      })
      .where('status = :s AND started_at < :corte', {
        s: ProcessRunStatus.RUNNING,
        corte,
      })
      .execute();
    return r.affected ?? 0;
  }

  @Cron('0 10 4 * * *', { timeZone: ZONA_ARGENTINA })
  @ConRegistro(ProcessName.PROCESS_RUN_PURGE)
  async purgar(ahora: Date = new Date()): Promise<{ purged: number }> {
    const dias = this.config.get<number>(
      'PROCESS_RUN_RETENTION_DAYS',
      RETENCION_POR_DEFECTO_DIAS,
    );
    const corte = new Date(ahora.getTime() - dias * 24 * 3600_000);
    // Se conserva la más nueva de cada (proceso, distribuidora): es el «último estado».
    const [, purged]: [unknown, number] = await this.runs.query(
      `DELETE FROM "process_run" r
        WHERE r."started_at" < $1
          AND EXISTS (
            SELECT 1 FROM "process_run" n
             WHERE n."process" = r."process"
               AND n."distributor_id" IS NOT DISTINCT FROM r."distributor_id"
               AND n."started_at" > r."started_at")`,
      [corte],
    );
    return { purged: Number(purged) };
  }
}
