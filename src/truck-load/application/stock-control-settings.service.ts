import { Injectable } from '@nestjs/common';
import { ModuleConfigService } from '../../distributor/module-config.service';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';

export interface StockControlSettings {
  requireOpenTruckLoad: boolean;
}

/**
 * Parámetros del control de stock del camión, por distribuidora, guardados en
 * `module_config` (proceso `stock_control`). Sin configuración rige el default:
 * el despacho NO exige carga abierta (decisión D5).
 */
@Injectable()
export class StockControlSettingsService {
  constructor(private readonly configs: ModuleConfigService) {}

  async obtener(distributorId: string): Promise<StockControlSettings> {
    const params = await this.configs.parametros(
      distributorId,
      ConfigurableProcess.STOCK_CONTROL,
    );
    return { requireOpenTruckLoad: params?.requireOpenTruckLoad === true };
  }

  async guardar(
    distributorId: string,
    settings: StockControlSettings,
    actorUserId: string,
  ): Promise<StockControlSettings> {
    await this.configs.guardar(
      distributorId,
      ConfigurableProcess.STOCK_CONTROL,
      { requireOpenTruckLoad: settings.requireOpenTruckLoad },
      actorUserId,
    );
    return this.obtener(distributorId);
  }
}
