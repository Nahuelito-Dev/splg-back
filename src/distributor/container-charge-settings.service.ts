import { Injectable } from '@nestjs/common';
import { ConfigurableProcess } from './entities/module-config.entity';
import { ModuleConfigService } from './module-config.service';

/** Interruptor por distribuidora del cobro de envases faltantes. */
@Injectable()
export class ContainerChargeSettingsService {
  constructor(private readonly configs: ModuleConfigService) {}

  /** Sin fila, con JSON inválido o fuera de la distribuidora: apagado. */
  async habilitado(distributorId: string | null | undefined): Promise<boolean> {
    if (!distributorId) return false;
    const params = await this.configs.parametros(
      distributorId,
      ConfigurableProcess.CONTAINER_CHARGE,
    );
    return params?.enabled === 1;
  }

  /** Estado que expone el panel; la ausencia de fila equivale a apagado. */
  async vigentes(distributorId: string): Promise<{ enabled: boolean }> {
    return { enabled: await this.habilitado(distributorId) };
  }

  async guardar(
    distributorId: string,
    enabled: boolean,
    actorUserId: string,
  ): Promise<{ enabled: boolean }> {
    await this.configs.guardar(
      distributorId,
      ConfigurableProcess.CONTAINER_CHARGE,
      { enabled: enabled ? 1 : 0 },
      actorUserId,
    );
    return { enabled };
  }
}
