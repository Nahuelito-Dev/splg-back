import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../redis/redis.service';
import { ConRegistro } from '../process-run/process-run.recorder';
import {
  marcarSaltada,
  registrarErrorAtrapado,
} from '../process-run/process-run.context';
import {
  EmpresasParaProceso,
  type EmpresaEnCurso,
} from '../process-run/empresas-para-proceso';
import { ProcessName } from '../process-run/domain/process-catalog';
import { DocumentReadingSettingsService } from './document-reading-settings.service';
import {
  DocumentReadingRunnerService,
  DocumentReadingRunResult,
} from './document-reading-runner.service';

@Injectable()
export class DocumentReadingCron {
  private readonly logger = new Logger(DocumentReadingCron.name);
  static readonly LOCK = 'cron:document-reading';
  constructor(
    private readonly runner: DocumentReadingRunnerService,
    private readonly settings: DocumentReadingSettingsService,
    private readonly redis: RedisService,
    private readonly empresas: EmpresasParaProceso,
  ) {}
  @Cron('0 * * * * *')
  @ConRegistro(ProcessName.DOCUMENT_READING)
  async ejecutar(): Promise<DocumentReadingRunResult | undefined> {
    try {
      const lock = await this.redis.withLock(
        DocumentReadingCron.LOCK,
        55_000,
        () => this.ejecutarSinCerrojo(),
      );
      if (lock.obtenido) return lock.valor;
      marcarSaltada();
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error('Lectura automática falló');
    }
  }
  async ejecutarSinCerrojo(
    ahora = new Date(),
  ): Promise<DocumentReadingRunResult> {
    if (!this.runner.disponible) {
      marcarSaltada();
      return {
        distributors: 0,
        read: 0,
        duplicates: 0,
        failed: 0,
        skipped: 0,
        budgetReached: 0,
      };
    }
    const total: DocumentReadingRunResult = {
      distributors: 0,
      read: 0,
      duplicates: 0,
      failed: 0,
      skipped: 0,
      budgetReached: 0,
    };
    // Sólo las empresas con el lector habilitado por la plataforma (módulo
    // `document_reading`): de las demás no se procesa la cola, que queda
    // `pending` y se retoma cuando se vuelve a habilitar.
    const { empresas } = await this.empresas.recorrer(
      {
        proceso: ProcessName.DOCUMENT_READING,
        modulo: 'document_reading',
        crea: true,
      },
      (distributorId, empresa) => this.leerUna(distributorId, ahora, empresa),
    );
    for (const { valor } of empresas) {
      if (!valor) continue;
      for (const key of Object.keys(
        total,
      ) as (keyof DocumentReadingRunResult)[])
        total[key] += valor[key];
    }
    if (total.distributors === 0) marcarSaltada();
    return total;
  }

  /** La lectura de una empresa si su llave está encendida y le toca por frecuencia. */
  private async leerUna(
    distributorId: string,
    ahora: Date,
    empresa: EmpresaEnCurso,
  ): Promise<DocumentReadingRunResult | null> {
    const settings = await this.settings.parametros(distributorId);
    if (!settings.enabled) return null;
    const key = `document-reading:ultima:${distributorId}`;
    const previous = await this.redis.get(key);
    if (
      previous &&
      ahora.getTime() - Number(previous) < settings.frequencyMinutes * 60_000
    )
      return null;
    // Re-consulta sin caché justo antes de leer (§6.3): el módulo se pudo
    // apagar después de elegir la empresa.
    if (!(await empresa.sigueHabilitada())) return null;
    let result: DocumentReadingRunResult;
    try {
      result = await this.runner.run(distributorId);
    } catch (error) {
      // «Correr ahora» de esa distribuidora está en curso: le toca en la próxima.
      if (error instanceof ConflictException) return null;
      throw error;
    }
    await this.redis.setex(key, 31 * 24 * 60 * 60, String(ahora.getTime()));
    return result;
  }
}
