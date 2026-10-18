import { BadRequestException, Injectable } from '@nestjs/common';
import { ModuleConfigService } from './module-config.service';
import { ConfigurableProcess } from './entities/module-config.entity';
import {
  ExpressSettings,
  expressSettingsDesde,
  expressSettingsPorDefecto,
  minutosDeHora,
  sonLosDeOmisionExpress,
} from './express-settings';

/** Lo que devuelve la API: los parámetros vigentes y quién los modificó. */
export interface ExpressSettingsVigentes extends ExpressSettings {
  isDefault: boolean;
  updatedAt: Date | null;
  updatedByUserId: string | null;
}

interface EntradaDeCache {
  settings: ExpressSettings;
  venceEn: number;
}

/**
 * Parámetros de la compra express por distribuidora (CU-172), con la misma
 * copia en memoria de un minuto que `DispatchSettingsService`: guardar descarta
 * la copia de esa distribuidora.
 */
@Injectable()
export class ExpressSettingsService {
  static readonly CACHE_TTL_MS = 60_000;

  private readonly cache = new Map<string, EntradaDeCache>();

  constructor(private readonly configs: ModuleConfigService) {}

  /** Los que rigen (con la copia en memoria). Sin distribuidora o sin configuración, los de omisión. */
  async obtener(
    distributorId: string | null | undefined,
  ): Promise<ExpressSettings> {
    if (!distributorId) return expressSettingsPorDefecto();

    const ahora = Date.now();
    const guardada = this.cache.get(distributorId);
    if (guardada && guardada.venceEn > ahora) return { ...guardada.settings };

    const params = await this.configs.parametros(
      distributorId,
      ConfigurableProcess.EXPRESS_DISPATCH,
    );
    const settings = expressSettingsDesde(params);
    this.cache.set(distributorId, {
      settings,
      venceEn: ahora + ExpressSettingsService.CACHE_TTL_MS,
    });
    return { ...settings };
  }

  /** Lo configurado en la base, sin la copia en memoria (lo que muestra el panel). */
  async vigentes(distributorId: string): Promise<ExpressSettingsVigentes> {
    const fila = await this.configs.fila(
      distributorId,
      ConfigurableProcess.EXPRESS_DISPATCH,
    );
    const settings = expressSettingsDesde(fila?.params ?? null);
    return {
      ...settings,
      isDefault: sonLosDeOmisionExpress(settings),
      updatedAt: fila?.updatedAt ?? null,
      updatedByUserId: fila?.updatedByUserId ?? null,
    };
  }

  /**
   * Guarda lo que vino; lo que falta toma su valor por omisión (reemplaza la
   * configuración). El horario tiene que empezar antes de terminar.
   */
  async guardar(
    distributorId: string,
    settings: Partial<ExpressSettings>,
    actorUserId: string,
  ): Promise<ExpressSettingsVigentes> {
    const base = expressSettingsPorDefecto();
    const desde = settings.serviceFrom ?? base.serviceFrom;
    const hasta = settings.serviceTo ?? base.serviceTo;
    if (minutosDeHora(desde) >= minutosDeHora(hasta)) {
      throw new BadRequestException(
        'El horario express tiene que empezar antes de terminar (serviceFrom < serviceTo, sin cruzar la medianoche)',
      );
    }
    const definidos = Object.fromEntries(
      Object.entries(settings).filter(([, v]) => v !== undefined && v !== null),
    );
    await this.configs.guardar(
      distributorId,
      ConfigurableProcess.EXPRESS_DISPATCH,
      definidos,
      actorUserId,
    );
    this.cache.delete(distributorId);
    return this.vigentes(distributorId);
  }
}
