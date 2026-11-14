import { Injectable } from '@nestjs/common';
import { DistributorStatus } from '../../distributor/entities/distributor.entity';
import { DistributorService } from '../../distributor/distributor.service';
import {
  CATALOGO,
  periodoEsperadoSeg,
  ProcessName,
} from '../../process-run/domain/process-catalog';
import { SALUD_CON_ALERTA } from '../../process-run/domain/process-health';
import {
  EstadoDeProceso,
  ProcessRunService,
} from '../../process-run/process-run.service';
import {
  CompanyProcessDto,
  PlatformProcessDto,
  PlatformProcessesResponseDto,
} from '../presentation/dto/platform-response.dto';

const UN_DIA_MS = 24 * 3600_000;

/** La salud de los procesos de toda la plataforma, leída de una vez. */
export interface SaludDeProcesos {
  estados: EstadoDeProceso[];
  fallas: Array<{
    process: ProcessName;
    distributorId: string | null;
    failures: number;
  }>;
}

/**
 * Monitoreo agregado de los procesos automáticos (panel de plataforma): por
 * proceso, cuántas empresas hay en cada estado de salud, las alertas y las
 * fallas de las últimas 24 horas. Tres consultas en total (última corrida,
 * última buena y fallas agrupadas), cualquiera sea la cantidad de empresas.
 */
@Injectable()
export class PlatformProcessesService {
  constructor(
    private readonly runs: ProcessRunService,
    private readonly distributors: DistributorService,
  ) {}

  async leer(ahora: Date = new Date()): Promise<SaludDeProcesos> {
    const [estados, fallas, empresas] = await Promise.all([
      this.runs.estados(null, ahora),
      this.runs.fallasDesde(new Date(ahora.getTime() - UN_DIA_MS)),
      this.distributors.findAll(),
    ]);
    const activas = new Set(
      empresas
        .filter((empresa) => empresa.status === DistributorStatus.ACTIVE)
        .map((empresa) => empresa.distributorId),
    );
    const esDeEmpresaActiva = (distributorId: string | null) =>
      distributorId === null || activas.has(distributorId);
    return {
      estados: estados.filter((estado) =>
        esDeEmpresaActiva(estado.distributorId),
      ),
      fallas: fallas.filter((falla) => esDeEmpresaActiva(falla.distributorId)),
    };
  }

  async resumen(
    ahora: Date = new Date(),
  ): Promise<PlatformProcessesResponseDto> {
    const { estados, fallas } = await this.leer(ahora);
    const items = Object.values(ProcessName).map((proceso) => {
      const propios = estados.filter((e) => e.proceso === proceso);
      const dto = new PlatformProcessDto();
      dto.process = proceso;
      dto.title = CATALOGO[proceso].title;
      dto.module = CATALOGO[proceso].module;
      dto.global = propios.some(
        (e) => e.distributorId === null && e.ultima !== null,
      );
      dto.companies = propios.filter((e) => e.distributorId !== null).length;
      dto.expectedEverySeconds = periodoEsperadoSeg(proceso);
      dto.health = {};
      for (const e of propios) {
        dto.health[e.salud] = (dto.health[e.salud] ?? 0) + 1;
      }
      dto.alerts = propios.filter((e) => SALUD_CON_ALERTA.has(e.salud)).length;
      dto.failuresLast24h = fallas
        .filter((f) => f.process === proceso)
        .reduce((n, f) => n + f.failures, 0);
      dto.lastRunAt = propios.reduce<Date | null>(
        (max, e) =>
          e.ultima && (!max || e.ultima.startedAt > max)
            ? e.ultima.startedAt
            : max,
        null,
      );
      return dto;
    });
    return {
      items,
      alerts: items.reduce((n, i) => n + i.alerts, 0),
      generatedAt: ahora,
    };
  }

  /** Alertas actuales por empresa (las corridas globales no son de ninguna). */
  static alertasPorEmpresa(salud: SaludDeProcesos): Map<string, number> {
    const mapa = new Map<string, number>();
    for (const e of salud.estados) {
      if (!e.distributorId || !SALUD_CON_ALERTA.has(e.salud)) continue;
      mapa.set(e.distributorId, (mapa.get(e.distributorId) ?? 0) + 1);
    }
    return mapa;
  }

  /** Los procesos de una empresa (sin los globales), con sus fallas del día. */
  static deLaEmpresa(
    salud: SaludDeProcesos,
    distributorId: string,
  ): CompanyProcessDto[] {
    return salud.estados
      .filter((e) => e.distributorId === distributorId)
      .map((e) => {
        const dto = new CompanyProcessDto();
        dto.process = e.proceso;
        dto.title = CATALOGO[e.proceso].title;
        dto.health = e.salud;
        dto.lastRunAt = e.ultima?.startedAt ?? null;
        dto.failuresLast24h = salud.fallas
          .filter(
            (f) => f.process === e.proceso && f.distributorId === distributorId,
          )
          .reduce((n, f) => n + f.failures, 0);
        return dto;
      });
  }

  /** Cuántas fallas hubo en 24 h en toda la plataforma. */
  static fallasTotales(salud: SaludDeProcesos): number {
    return salud.fallas.reduce((n, f) => n + f.failures, 0);
  }

  /** Cuántas alertas hay (por empresa y globales). */
  static alertasTotales(salud: SaludDeProcesos): number {
    return salud.estados.filter((e) => SALUD_CON_ALERTA.has(e.salud)).length;
  }
}
