import { Injectable, NotFoundException } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { ModuleConfigService } from './module-config.service';
import {
  ESQUEMAS,
  PROCESOS_AUTOMATICOS,
  CampoDeProceso,
  ProcesoAutomatico,
  ValoresDeProceso,
  esProcesoAutomatico,
  sonLosDeOmision,
  validarParametros,
  valoresDesde,
} from './process-config';

/** Lo que devuelve la API: el esquema del proceso, sus valores vigentes y quién los modificó. */
export interface ProcesoVigente {
  process: ProcesoAutomatico;
  title: string;
  description: string;
  fields: CampoDeProceso[];
  params: ValoresDeProceso;
  isDefault: boolean;
  updatedAt: Date | null;
  updatedByUserId: string | null;
}

/**
 * Parámetros de los cinco procesos automáticos configurables por distribuidora
 * (CU-172): valida contra el esquema de cada proceso y guarda con
 * `ModuleConfigService`. Una sola operación atiende a los cinco: lo que cambia
 * entre ellos es el esquema, no el flujo. Los procesos que consumen estos
 * parámetros los leen con `obtener`.
 */
@Injectable()
export class ProcessConfigService {
  constructor(private readonly configs: ModuleConfigService) {}

  /** El proceso del path, o 404 si no es uno de los cinco configurables. */
  procesoConfigurable(proceso: string): ProcesoAutomatico {
    if (!esProcesoAutomatico(proceso)) {
      throw new NotFoundException(
        `El proceso "${proceso}" no es un proceso automático configurable`,
      );
    }
    return proceso;
  }

  /** Los valores que rigen para la distribuidora (los suyos o los de omisión). */
  async obtener(
    distributorId: string,
    proceso: ProcesoAutomatico,
  ): Promise<ValoresDeProceso> {
    const params = await this.configs.parametros(distributorId, proceso);
    return valoresDesde(ESQUEMAS[proceso], params);
  }

  async vigentes(
    distributorId: string,
    proceso: ProcesoAutomatico,
  ): Promise<ProcesoVigente> {
    const esquema = ESQUEMAS[proceso];
    const fila = await this.configs.fila(distributorId, proceso);
    const params = valoresDesde(esquema, fila?.params ?? null);
    return {
      process: proceso,
      title: esquema.title,
      description: esquema.description,
      fields: esquema.fields,
      params,
      isDefault: sonLosDeOmision(esquema, params),
      updatedAt: fila?.updatedAt ?? null,
      updatedByUserId: fila?.updatedByUserId ?? null,
    };
  }

  /** Los cinco procesos con sus valores vigentes (la pantalla de procesos automáticos). */
  todos(distributorId: string): Promise<ProcesoVigente[]> {
    return Promise.all(
      PROCESOS_AUTOMATICOS.map((p) => this.vigentes(distributorId, p)),
    );
  }

  /**
   * Reemplaza los parámetros del proceso: sólo se guarda lo que viene, lo demás
   * se lee con su valor por omisión (un cuerpo vacío restablece todo).
   */
  async guardar(
    distributorId: string,
    proceso: ProcesoAutomatico,
    cuerpo: unknown,
    actorUserId: string,
  ): Promise<ProcesoVigente> {
    const errores = validarParametros(ESQUEMAS[proceso], cuerpo);
    if (errores.length > 0) throw new BadRequestException(errores);
    await this.configs.guardar(
      distributorId,
      proceso,
      { ...(cuerpo as Record<string, number>) },
      actorUserId,
    );
    return this.vigentes(distributorId, proceso);
  }
}
