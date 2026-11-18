import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import {
  CATALOGO,
  periodoEsperadoSeg,
  ProcessHealth,
  ProcessName,
  ProcessRunStatus,
  RunTrigger,
} from './domain/process-catalog';
import {
  evaluarSalud,
  proximaEsperada,
  SALUD_CON_ALERTA,
} from './domain/process-health';
import {
  ProcessRunDetailResponseDto,
  ProcessRunListResponseDto,
  ProcessSummaryItemDto,
  ProcessSummaryResponseDto,
} from './dto/process-run-response.dto';
import { QueryProcessRunsDto } from './dto/query-process-runs.dto';
import { ProcessRun } from './entities/process-run.entity';
import { ProcessRunMapper } from './process-run.mapper';
import { AdminNotification } from '../admin-notifications/entities/admin-notification.entity';
import { conCodigo } from '../common/errors/con-codigo';

/** Cuántos avisos de la misma traza trae el detalle de una corrida. */
export const AVISOS_DEL_DETALLE = 50;

export const CUELGA_POR_DEFECTO_MIN = 30;

/** La última corrida de cada proceso (y distribuidora) con su salud. */
export interface EstadoDeProceso {
  proceso: ProcessName;
  distributorId: string | null;
  ultima: ProcessRun | null;
  ultimaBuena: Date | null;
  salud: ProcessHealth;
}

@Injectable()
export class ProcessRunService {
  constructor(
    @InjectRepository(ProcessRun)
    private readonly runs: Repository<ProcessRun>,
    private readonly config: ConfigService,
    @InjectRepository(AdminNotification)
    private readonly avisos: Repository<AdminNotification>,
  ) {}

  get cuelgaMinutos(): number {
    return this.config.get<number>(
      'PROCESS_RUN_STUCK_MINUTES',
      CUELGA_POR_DEFECTO_MIN,
    );
  }

  /**
   * Un tenant ve sus corridas y las globales (barridos de todas las
   * distribuidoras); sin tenant (super admin) se ven todas.
   */
  private delAlcance(
    qb: SelectQueryBuilder<ProcessRun>,
    distributorId: string | null,
  ): SelectQueryBuilder<ProcessRun> {
    if (distributorId) {
      qb.andWhere(
        '(r.distributorId = :distributorId OR r.distributorId IS NULL)',
        { distributorId },
      );
    }
    return qb;
  }

  /**
   * El estado de cada proceso. Con tenant, una fila por proceso (la última entre
   * la propia y la global); sin tenant, una por proceso y distribuidora.
   */
  async estados(
    distributorId: string | null,
    ahora: Date = new Date(),
  ): Promise<EstadoDeProceso[]> {
    const ultimas = await this.delAlcance(
      this.runs
        .createQueryBuilder('r')
        .distinctOn(['r.process', 'r.distributorId'])
        // Lo que no cuenta para el estado: la corrida salteada por cerrojo y la adelantada por un webhook
        // (una corrida manual sí cuenta).
        .where('r.status <> :saltada AND r.trigger <> :webhook', {
          saltada: ProcessRunStatus.SKIPPED,
          webhook: RunTrigger.WEBHOOK,
        })
        .orderBy('r.process')
        .addOrderBy('r.distributorId')
        .addOrderBy('r.startedAt', 'DESC'),
      distributorId,
    ).getMany();
    const buenas = await this.delAlcance(
      this.runs
        .createQueryBuilder('r')
        .distinctOn(['r.process', 'r.distributorId'])
        .where('r.status IN (:...ok) AND r.trigger <> :webhook', {
          ok: [ProcessRunStatus.OK, ProcessRunStatus.PARTIAL],
          webhook: RunTrigger.WEBHOOK,
        })
        .orderBy('r.process')
        .addOrderBy('r.distributorId')
        .addOrderBy('r.startedAt', 'DESC'),
      distributorId,
    ).getMany();

    // La salteada más reciente (no había trabajo, o la tomó otra instancia): no cambia el estado, pero
    // prueba que el proceso sigue corriendo a horario, así que cuenta para medir el atraso.
    const salteadas = await this.delAlcance(
      this.runs
        .createQueryBuilder('r')
        .distinctOn(['r.process', 'r.distributorId'])
        .where('r.status = :saltada AND r.trigger <> :webhook', {
          saltada: ProcessRunStatus.SKIPPED,
          webhook: RunTrigger.WEBHOOK,
        })
        .orderBy('r.process')
        .addOrderBy('r.distributorId')
        .addOrderBy('r.startedAt', 'DESC'),
      distributorId,
    ).getMany();

    const grupos = new Map<string, ProcessRun[]>();
    for (const run of ultimas) {
      const clave = distributorId
        ? run.process
        : `${run.process}:${run.distributorId ?? ''}`;
      grupos.set(clave, [...(grupos.get(clave) ?? []), run]);
    }
    const buenaDe = (proceso: ProcessName, d: string | null): Date | null => {
      const propias = buenas.filter(
        (b) =>
          b.process === proceso && (distributorId || b.distributorId === d),
      );
      return propias.reduce<Date | null>(
        (max, b) => (!max || b.startedAt > max ? b.startedAt : max),
        null,
      );
    };

    const estados: EstadoDeProceso[] = [];
    for (const proceso of Object.values(ProcessName)) {
      const delProceso = [...grupos.entries()].filter(
        ([k]) => k === String(proceso) || k.startsWith(`${proceso}:`),
      );
      if (delProceso.length === 0) {
        estados.push({
          proceso,
          distributorId: null,
          ultima: null,
          ultimaBuena: null,
          salud: ProcessHealth.NEVER,
        });
        continue;
      }
      for (const [, filas] of delProceso) {
        const ultima = filas.reduce((a, b) =>
          b.startedAt > a.startedAt ? b : a,
        );
        let salud = evaluarSalud(ultima, proceso, ahora, this.cuelgaMinutos);
        if (salud === ProcessHealth.LATE) {
          const viva = salteadas
            .filter(
              (s) =>
                s.process === proceso &&
                (distributorId || s.distributorId === ultima.distributorId),
            )
            .reduce<Date | null>(
              (max, s) => (!max || s.startedAt > max ? s.startedAt : max),
              null,
            );
          if (viva && viva > ultima.startedAt) {
            salud = evaluarSalud(
              { ...ultima, startedAt: viva },
              proceso,
              ahora,
              this.cuelgaMinutos,
            );
          }
        }
        estados.push({
          proceso,
          distributorId: ultima.distributorId,
          ultima,
          ultimaBuena: buenaDe(proceso, ultima.distributorId),
          salud,
        });
      }
    }
    return estados;
  }

  /**
   * La salud de cada proceso (monitoreo de la plataforma): una fila por
   * proceso y empresa, más las corridas globales. Con `distributorId`, sólo las
   * de esa empresa (sin las globales).
   */
  async resumen(
    distributorId: string | null = null,
  ): Promise<ProcessSummaryResponseDto> {
    const ahora = new Date();
    const estados = (await this.estados(null, ahora)).filter(
      (e) => !distributorId || e.distributorId === distributorId,
    );
    if (distributorId) {
      const presentes = new Set(estados.map((e) => e.proceso));
      for (const proceso of Object.values(ProcessName)) {
        if (presentes.has(proceso)) continue;
        estados.push({
          proceso,
          distributorId,
          ultima: null,
          ultimaBuena: null,
          salud: ProcessHealth.NEVER,
        });
      }
    }
    const items = estados.map((e): ProcessSummaryItemDto => {
      const dto = new ProcessSummaryItemDto();
      dto.process = e.proceso;
      dto.title = CATALOGO[e.proceso].title;
      dto.module = CATALOGO[e.proceso].module;
      dto.distributorId = e.distributorId;
      dto.health = e.salud;
      dto.lastRun = e.ultima ? ProcessRunMapper.toDto(e.ultima, true) : null;
      dto.lastOkAt = e.ultimaBuena;
      dto.expectedEverySeconds = periodoEsperadoSeg(e.proceso);
      dto.nextExpectedAt = e.ultima
        ? proximaEsperada(e.ultima.startedAt, e.proceso)
        : null;
      return dto;
    });
    return {
      items,
      alerts: estados.filter((e) => SALUD_CON_ALERTA.has(e.salud)).length,
      generatedAt: ahora,
    };
  }

  /**
   * Corridas fallidas desde `desde`, por proceso y empresa (una sola consulta
   * agrupada; `distributorId` nulo es la corrida global).
   */
  async fallasDesde(desde: Date): Promise<
    Array<{
      process: ProcessName;
      distributorId: string | null;
      failures: number;
    }>
  > {
    const filas = await this.runs
      .createQueryBuilder('r')
      .select('r.process', 'process')
      .addSelect('r.distributorId', 'distributorId')
      .addSelect('COUNT(*)', 'failures')
      .where('r.status = :fallida AND r.startedAt >= :desde', {
        fallida: ProcessRunStatus.FAILED,
        desde,
      })
      .groupBy('r.process')
      .addGroupBy('r.distributorId')
      .getRawMany<{
        process: ProcessName;
        distributorId: string | null;
        failures: string;
      }>();
    return filas.map((f) => ({
      process: f.process,
      distributorId: f.distributorId ?? null,
      failures: Number(f.failures),
    }));
  }

  /** El historial de corridas de todas las empresas (monitoreo de la plataforma). */
  async listar(query: QueryProcessRunsDto): Promise<ProcessRunListResponseDto> {
    const desde = query.from ? new Date(query.from) : null;
    const hasta = query.to ? new Date(query.to) : null;
    if (desde && hasta && desde > hasta) {
      throw new BadRequestException('from no puede ser posterior a to');
    }
    const qb = this.runs.createQueryBuilder('r');
    if (query.distributorId)
      qb.andWhere('r.distributorId = :distributorId', {
        distributorId: query.distributorId,
      });
    if (query.process)
      qb.andWhere('r.process = :process', { process: query.process });
    if (query.status)
      qb.andWhere('r.status = :status', { status: query.status });
    if (desde) qb.andWhere('r.startedAt >= :desde', { desde });
    if (hasta) qb.andWhere('r.startedAt <= :hasta', { hasta });
    const [filas, total] = await qb
      .orderBy('r.startedAt', 'DESC')
      .addOrderBy('r.runId', 'DESC')
      .take(query.limit)
      .skip(query.offset)
      .getManyAndCount();
    return {
      items: filas.map((r) => ProcessRunMapper.toDto(r, true)),
      total,
    };
  }

  /**
   * Una corrida con todo su detalle (DISENO-OBSERVABILIDAD §7.1) y los avisos
   * de la bandeja que salieron de su misma traza. 404 `PROCESS_RUN_NOT_FOUND`
   * si no existe (o ya se purgó).
   */
  async detalle(runId: string): Promise<ProcessRunDetailResponseDto> {
    const run = await this.runs.findOne({ where: { runId } });
    if (!run) {
      throw conCodigo(
        NotFoundException,
        404,
        'No existe esa corrida (o ya se depuró por antigüedad)',
        'PROCESS_RUN_NOT_FOUND',
      );
    }
    const avisos = run.traceId
      ? await this.avisos.find({
          where: { traceId: run.traceId },
          order: { createdAt: 'ASC', notificationId: 'ASC' },
          take: AVISOS_DEL_DETALLE,
        })
      : [];
    return ProcessRunMapper.toDetailDto(run, avisos);
  }
}
