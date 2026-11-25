import { Injectable } from '@nestjs/common';
import {
  CylinderQueryService,
  VencimientosDelParque,
  VigenciaDeEnvase,
} from './application/cylinder-query.service';
import { RegisterInspectionUseCase } from './application/register-inspection.use-case';
import type { DatosDeRevision } from './domain/revision-de-envase';

export type {
  EnvaseConVigencia,
  VencimientosDelParque,
  VigenciaDeEnvase,
} from './application/cylinder-query.service';

/**
 * Fachada de la vigencia de los envases (C-11): registrar la revisión
 * periódica, consultar hasta cuándo puede circular cada envase y listar los
 * próximos a vencer. Las reglas están en el dominio (`Envase`,
 * `planificarRevision`, `calcularVigencia`) y las comparte el bloqueo del
 * despacho (CU-135).
 */
@Injectable()
export class CylinderVigenciaService {
  constructor(
    private readonly registrar: RegisterInspectionUseCase,
    private readonly consultas: CylinderQueryService,
  ) {}

  /** CU-132. Asienta la revisión y devuelve la vigencia como quedó. */
  async registerInspection(
    cylinderId: string,
    datos: DatosDeRevision,
    distributorId: string,
    actorUserId?: string,
  ): Promise<VigenciaDeEnvase> {
    await this.registrar.execute(cylinderId, datos, distributorId, actorUserId);
    return this.consultas.getVigencia(cylinderId, distributorId);
  }

  /** CU-133. Vigencia de un envase por id. */
  getVigencia(
    cylinderId: string,
    distributorId?: string | null,
  ): Promise<VigenciaDeEnvase> {
    return this.consultas.getVigencia(cylinderId, distributorId);
  }

  /** CU-133. Vigencia de un envase por su número de serie (lo que se escanea). */
  getVigenciaBySerial(
    serial: string,
    distributorId?: string | null,
  ): Promise<VigenciaDeEnvase> {
    return this.consultas.getVigenciaBySerial(serial, distributorId);
  }

  /** CU-134. Vencidos, por vencer dentro de la ventana y sin revisión registrada. */
  findExpiring(
    days: number,
    distributorId?: string | null,
    limit = 100,
    offset = 0,
  ): Promise<VencimientosDelParque> {
    return this.consultas.findExpiring(days, distributorId, limit, offset);
  }
}
