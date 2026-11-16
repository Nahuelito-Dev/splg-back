import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ConfigurableProcess,
  ModuleConfig,
  ModuleConfigParams,
} from './entities/module-config.entity';

/**
 * Lectura y escritura de los parámetros por distribuidora y proceso
 * (`module_config`). La forma de cada conjunto de parámetros la define y valida
 * quien lo usa; acá sólo se guardan.
 */
@Injectable()
export class ModuleConfigService {
  constructor(
    @InjectRepository(ModuleConfig)
    private readonly configs: Repository<ModuleConfig>,
  ) {}

  /** Los parámetros guardados, o `null` si la distribuidora no configuró el proceso. */
  async parametros(
    distributorId: string,
    module: ConfigurableProcess,
  ): Promise<ModuleConfigParams | null> {
    const fila = await this.configs.findOne({
      where: { distributorId, module },
    });
    return fila?.params ?? null;
  }

  /** La fila completa (parámetros, cuándo y quién la modificó), o `null` si no existe. */
  fila(
    distributorId: string,
    module: ConfigurableProcess,
  ): Promise<ModuleConfig | null> {
    return this.configs.findOne({ where: { distributorId, module } });
  }

  /** Reemplaza los parámetros del proceso (crea la fila la primera vez). */
  async guardar(
    distributorId: string,
    module: ConfigurableProcess,
    params: ModuleConfigParams,
    updatedByUserId: string | null,
  ): Promise<void> {
    await this.configs.query(
      `INSERT INTO "module_config" ("distributor_id", "module", "params", "updated_by_user_id")
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT ("distributor_id", "module")
       DO UPDATE SET "params" = EXCLUDED."params", "updated_at" = now(),
                     "updated_by_user_id" = EXCLUDED."updated_by_user_id"`,
      [distributorId, module, JSON.stringify(params), updatedByUserId],
    );
  }
}
