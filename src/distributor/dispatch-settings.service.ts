import { Injectable } from '@nestjs/common';
import { ModuleConfigService } from './module-config.service';
import { ConfigurableProcess } from './entities/module-config.entity';
import {
  DispatchSettings,
  dispatchSettingsDesde,
  dispatchSettingsPorDefecto,
  sonLosDeOmision,
} from './dispatch-settings';

/** Lo que devuelve la API: los parámetros vigentes y quién los modificó. */
export interface DispatchSettingsVigentes extends DispatchSettings {
  isDefault: boolean;
  updatedAt: Date | null;
  updatedByUserId: string | null;
}

interface EntradaDeCache {
  settings: DispatchSettings;
  venceEn: number;
}

/**
 * Parámetros del despacho por distribuidora (CU-171), guardados en
 * `module_config` (proceso `dispatch`). El orquestador los pide en cada oferta,
 * así que se guarda una copia en memoria de un minuto por distribuidora para no
 * ir a la base en cada ciclo; guardar descarta la copia de esa distribuidora
 * (en las demás instancias el cambio rige, como máximo, un minuto después).
 */
@Injectable()
export class DispatchSettingsService {
  static readonly CACHE_TTL_MS = 60_000;

  private readonly cache = new Map<string, EntradaDeCache>();

  constructor(private readonly configs: ModuleConfigService) {}

  /**
   * Los parámetros que rigen para la distribuidora (con la copia en memoria).
   * Sin distribuidora o sin configuración, los de omisión.
   */
  async obtener(
    distributorId: string | null | undefined,
  ): Promise<DispatchSettings> {
    if (!distributorId) return dispatchSettingsPorDefecto();

    const ahora = Date.now();
    const guardada = this.cache.get(distributorId);
    if (guardada && guardada.venceEn > ahora) {
      return this.copia(guardada.settings);
    }

    const params = await this.configs.parametros(
      distributorId,
      ConfigurableProcess.DISPATCH,
    );
    const settings = dispatchSettingsDesde(params);
    this.cache.set(distributorId, {
      settings,
      venceEn: ahora + DispatchSettingsService.CACHE_TTL_MS,
    });
    return this.copia(settings);
  }

  /** Lo configurado en la base, sin la copia en memoria (lo que muestra el panel). */
  async vigentes(distributorId: string): Promise<DispatchSettingsVigentes> {
    const fila = await this.configs.fila(
      distributorId,
      ConfigurableProcess.DISPATCH,
    );
    const settings = dispatchSettingsDesde(fila?.params ?? null);
    return {
      ...settings,
      isDefault: sonLosDeOmision(settings),
      updatedAt: fila?.updatedAt ?? null,
      updatedByUserId: fila?.updatedByUserId ?? null,
    };
  }

  async guardar(
    distributorId: string,
    settings: Partial<DispatchSettings>,
    actorUserId: string,
  ): Promise<DispatchSettingsVigentes> {
    await this.configs.guardar(
      distributorId,
      ConfigurableProcess.DISPATCH,
      // Sólo lo que vino: lo que falta se lee con su valor por omisión.
      {
        ...(settings.radiusStepsKm != null
          ? { radiusStepsKm: settings.radiusStepsKm }
          : {}),
        ...(settings.offerTtlSeconds != null
          ? { offerTtlSeconds: settings.offerTtlSeconds }
          : {}),
        ...(settings.finishingRadiusMeters != null
          ? { finishingRadiusMeters: settings.finishingRadiusMeters }
          : {}),
      },
      actorUserId,
    );
    this.cache.delete(distributorId);
    return this.vigentes(distributorId);
  }

  private copia(settings: DispatchSettings): DispatchSettings {
    return {
      radiusStepsKm: [...settings.radiusStepsKm],
      offerTtlSeconds: settings.offerTtlSeconds,
      finishingRadiusMeters: settings.finishingRadiusMeters,
    };
  }
}
