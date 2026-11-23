import { Injectable, NotFoundException } from '@nestjs/common';
import { DistributorStatus } from '../../distributor/entities/distributor.entity';
import { PlatformMetricsRepository } from '../infrastructure/platform-metrics.repository';
import type { FilaDeMetricas } from '../infrastructure/platform-metrics.repository';
import {
  CompanyCountsDto,
  CompanyDetailResponseDto,
  CompanyListItemDto,
  CompanyListResponseDto,
  PlatformOverviewResponseDto,
} from '../presentation/dto/platform-response.dto';
import { PlatformMapper, sinMetricas } from '../presentation/platform.mapper';
import { mesDe, periodoDe } from './periodo';
import { PlatformProcessesService } from './platform-processes.service';
import { PlatformUsageService } from './platform-usage.service';
import { EntityPhotoService } from '../../s3/entity-photo.service';

/** Las sesiones de soporte que muestra la ficha de una empresa. */
export const SESIONES_EN_LA_FICHA = 10;

export interface FiltroDeEmpresas {
  from?: string;
  to?: string;
  status?: DistributorStatus;
  ownedByPlatform?: boolean;
  limit: number;
  offset: number;
}

/**
 * Tablero, lista y ficha de las empresas (panel de plataforma). Las métricas
 * salen de consultas agrupadas por empresa (`PlatformMetricsRepository`): la
 * cantidad de consultas no crece con la cantidad de empresas. El total del
 * tablero es la suma de las mismas filas que muestra la lista, así cuadran.
 */
@Injectable()
export class PlatformCompaniesService {
  constructor(
    private readonly repo: PlatformMetricsRepository,
    private readonly procesos: PlatformProcessesService,
    private readonly uso: PlatformUsageService,
    private readonly fotos: EntityPhotoService,
  ) {}

  async tablero(
    from: string | undefined,
    to: string | undefined,
    ahora: Date = new Date(),
  ): Promise<PlatformOverviewResponseDto> {
    const periodo = periodoDe(from, to, ahora);
    const estados = await this.repo.estados();
    const metricas = await this.repo.metricas(
      null,
      periodo.desde,
      periodo.hasta,
      ahora,
    );
    const lector = await this.uso.totalDelMes(mesDe(undefined, ahora));
    const salud = await this.procesos.leer(ahora);

    const companies = new CompanyCountsDto();
    const cuantas = (s: DistributorStatus) =>
      estados.find((e) => e.status === String(s))?.cantidad ?? 0;
    companies.active = cuantas(DistributorStatus.ACTIVE);
    companies.suspended = cuantas(DistributorStatus.SUSPENDED);
    companies.total = estados.reduce((n, e) => n + e.cantidad, 0);

    const dto = new PlatformOverviewResponseDto();
    dto.range = { from: periodo.from, to: periodo.to };
    dto.companies = companies;
    dto.totals = PlatformMapper.sumar(metricas);
    dto.documentReading = lector;
    dto.processes = {
      alerts: PlatformProcessesService.alertasTotales(salud),
      failuresLast24h: PlatformProcessesService.fallasTotales(salud),
    };
    dto.supportSessions = {
      active: metricas.filter((m) => m.soporte_activo).length,
      pending: metricas.reduce((n, m) => n + m.soporte_pendiente, 0),
    };
    dto.generatedAt = ahora;
    return dto;
  }

  async listar(
    filtro: FiltroDeEmpresas,
    ahora: Date = new Date(),
  ): Promise<CompanyListResponseDto> {
    const periodo = periodoDe(filtro.from, filtro.to, ahora);
    const { filas, total } = await this.repo.empresas(
      filtro.status ?? null,
      filtro.ownedByPlatform ?? null,
      filtro.limit,
      filtro.offset,
    );
    const ids = filas.map((f) => f.id);
    const metricas = ids.length
      ? await this.repo.metricas(ids, periodo.desde, periodo.hasta, ahora)
      : [];
    const deCada = new Map(metricas.map((m) => [m.id, m]));
    const alertas = ids.length
      ? PlatformProcessesService.alertasPorEmpresa(
          await this.procesos.leer(ahora),
        )
      : new Map<string, number>();

    const items = await Promise.all(
      filas.map(async (f) => {
        const m: FilaDeMetricas = deCada.get(f.id) ?? sinMetricas();
        const dto = new CompanyListItemDto();
        dto.id = f.id;
        dto.name = f.name;
        dto.slug = f.slug;
        dto.logoUrl = await this.fotos.urlDe(f.logo_key);
        dto.status = f.status as DistributorStatus;
        dto.ownedByPlatform = f.owned_by_platform;
        dto.plan = f.plan;
        dto.createdAt = new Date(f.created_at);
        dto.lastActivityAt = m.ultima_actividad;
        dto.metrics = PlatformMapper.metricas(m);
        dto.processAlerts = alertas.get(f.id) ?? 0;
        dto.supportSessionActive = m.soporte_activo;
        dto.supportRequestsPending = m.soporte_pendiente;
        return dto;
      }),
    );
    return { range: { from: periodo.from, to: periodo.to }, items, total };
  }

  /** La ficha consolidada; 404 si no existe o está dada de baja. */
  async ficha(
    id: string,
    from: string | undefined,
    to: string | undefined,
    ahora: Date = new Date(),
  ): Promise<CompanyDetailResponseDto> {
    const periodo = periodoDe(from, to, ahora);
    const empresa = await this.repo.empresa(id);
    if (!empresa) throw new NotFoundException('No existe esa empresa');

    const [metricas] = await this.repo.metricas(
      [id],
      periodo.desde,
      periodo.hasta,
      ahora,
    );
    const m = metricas ?? sinMetricas();
    const salud = await this.procesos.leer(ahora);

    const dto = new CompanyDetailResponseDto();
    dto.range = { from: periodo.from, to: periodo.to };
    dto.company = PlatformMapper.empresa(empresa);
    dto.metrics = PlatformMapper.metricas(m);
    dto.lastActivityAt = m.ultima_actividad;
    dto.documentReading = await this.uso.deLaEmpresa(
      id,
      mesDe(undefined, ahora),
    );
    dto.processes = PlatformProcessesService.deLaEmpresa(salud, id);
    dto.admins = (await this.repo.admins(id)).map((a) =>
      PlatformMapper.admin(a),
    );
    dto.supportSessions = (
      await this.repo.sesionesRecientes(id, SESIONES_EN_LA_FICHA)
    ).map((s) => PlatformMapper.sesion(s));
    return dto;
  }
}
