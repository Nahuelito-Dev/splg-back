import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { ESQUEMAS, valoresDesde } from '../../distributor/process-config';
import { PlatformMetricsRepository } from '../infrastructure/platform-metrics.repository';
import {
  CompanyDocumentReadingDto,
  DocumentReadingTotalsDto,
  DocumentReadingUsageItemDto,
  DocumentReadingUsageResponseDto,
} from '../presentation/dto/platform-response.dto';
import { dolares } from '../presentation/platform.mapper';
import type { Mes } from './periodo';

const ESQUEMA_DEL_LECTOR = ESQUEMAS[ConfigurableProcess.DOCUMENT_READING];

/** El tope y el encendido del lector de una empresa (lo guardado o, si no, lo de omisión). */
function parametrosDelLector(params: Record<string, unknown> | null): {
  enabled: boolean;
  monthlyBudgetUsd: number;
} {
  const v = valoresDesde(ESQUEMA_DEL_LECTOR, params);
  return { enabled: v.enabled === 1, monthlyBudgetUsd: v.monthlyBudgetUsd };
}

/** Qué parte del tope se usó, en porcentaje con 2 decimales (0 si no hay tope). */
export function porcentajeDelTope(costo: number, tope: number): number {
  if (tope <= 0) return 0;
  return new Decimal(costo)
    .div(tope)
    .times(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toNumber();
}

/**
 * Uso y costo del lector de documentos por empresa y mes (panel de
 * plataforma). Mismo criterio que el gasto del mes de cada empresa: lecturas
 * que llegaron al proveedor, por la fecha del intento, en hora argentina.
 */
@Injectable()
export class PlatformUsageService {
  constructor(private readonly repo: PlatformMetricsRepository) {}

  async porEmpresa(mes: Mes): Promise<DocumentReadingUsageResponseDto> {
    const empresas = await this.repo.nombres();
    const uso = new Map(
      (await this.repo.lector(null, mes.desde, mes.hasta)).map((f) => [
        f.id,
        f,
      ]),
    );
    const parametros = new Map(
      (await this.repo.parametrosDelLector(null)).map((f) => [f.id, f.params]),
    );
    const items = empresas.map((e) => {
      const u = uso.get(e.id);
      const p = parametrosDelLector(parametros.get(e.id) ?? null);
      const dto = new DocumentReadingUsageItemDto();
      dto.distributorId = e.id;
      dto.name = e.name;
      dto.readings = u?.lecturas ?? 0;
      dto.costUsd = dolares([u?.costo ?? '0']);
      dto.monthlyBudgetUsd = p.monthlyBudgetUsd;
      dto.enabled = p.enabled;
      dto.budgetUsedPct = porcentajeDelTope(dto.costUsd, p.monthlyBudgetUsd);
      return dto;
    });
    // De mayor a menor costo; a igual costo, por nombre (el orden de la consulta).
    const ordenados = items
      .map((item, i) => ({ item, i }))
      .sort((a, b) => b.item.costUsd - a.item.costUsd || a.i - b.i)
      .map(({ item }) => item);
    return {
      month: mes.month,
      items: ordenados,
      totalReadings: items.reduce((n, i) => n + i.readings, 0),
      totalCostUsd: dolares(
        [...uso.values()]
          .filter((f) => empresas.some((e) => e.id === f.id))
          .map((f) => f.costo),
      ),
    };
  }

  /** El total del mes de todas las empresas vigentes (para el tablero). */
  async totalDelMes(mes: Mes): Promise<DocumentReadingTotalsDto> {
    const r = await this.porEmpresa(mes);
    const dto = new DocumentReadingTotalsDto();
    dto.month = r.month;
    dto.readings = r.totalReadings;
    dto.costUsd = r.totalCostUsd;
    return dto;
  }

  /** El uso del mes de una empresa, con su tope (para la ficha). */
  async deLaEmpresa(
    distributorId: string,
    mes: Mes,
  ): Promise<CompanyDocumentReadingDto> {
    const [u] = await this.repo.lector([distributorId], mes.desde, mes.hasta);
    const [fila] = await this.repo.parametrosDelLector([distributorId]);
    const p = parametrosDelLector(fila?.params ?? null);
    const dto = new CompanyDocumentReadingDto();
    dto.month = mes.month;
    dto.readings = u?.lecturas ?? 0;
    dto.costUsd = dolares([u?.costo ?? '0']);
    dto.enabled = p.enabled;
    dto.monthlyBudgetUsd = p.monthlyBudgetUsd;
    return dto;
  }
}
