import { errorMessage } from '../common/errors/error-message';
import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { registrarErrorAtrapado } from '../process-run/process-run.context';
import { RedisService } from '../redis/redis.service';
import { S3Service } from '../s3/s3.service';
import { DocumentReadingService } from './document-reading.service';
import { DocumentReadingQueueService } from './document-reading-queue.service';
import { DocumentReadingSettingsService } from './document-reading-settings.service';
import { DOCUMENT_READING_OWNERS } from './document-reading-owners';
import { DocumentReadingStatus } from './entities/document-reading.entity';
import { DocumentReadingProposalService } from './document-reading-proposal.service';

export interface DocumentReadingRunResult {
  distributors: number;
  read: number;
  duplicates: number;
  failed: number;
  skipped: number;
  budgetReached: number;
}
/**
 * Una corrida por distribuidora a la vez (el cron y «correr ahora» comparten el
 * cerrojo): dos corridas simultáneas podían leer el mismo adjunto y pasarse del tope.
 */
const CERROJO_CORRIDA_TTL_MS = 120_000;
/** Lo que se estima que cuesta leer un documento si todavía no hay lecturas en el mes. */
export const COSTO_ESTIMADO_POR_OMISION_USD = 0.05;

const EMPTY: DocumentReadingRunResult = {
  distributors: 0,
  read: 0,
  duplicates: 0,
  failed: 0,
  skipped: 0,
  budgetReached: 0,
};

@Injectable()
export class DocumentReadingRunnerService {
  private readonly logger = new Logger(DocumentReadingRunnerService.name);

  constructor(
    private readonly settings: DocumentReadingSettingsService,
    private readonly queue: DocumentReadingQueueService,
    private readonly readings: DocumentReadingService,
    private readonly s3: S3Service,
    private readonly redis: RedisService,
    private readonly proposals: DocumentReadingProposalService,
  ) {}
  get disponible(): boolean {
    return this.readings.disponible;
  }
  async run(
    distributorId: string,
    options: { dryRun?: boolean; ignoreEnabled?: boolean } = {},
  ): Promise<DocumentReadingRunResult> {
    const params = await this.settings.parametros(distributorId);
    if (!params.enabled && !options.dryRun && !options.ignoreEnabled)
      throw new ConflictException('La lectura de documentos está apagada');
    if (!options.dryRun && !this.readings.disponible)
      throw new ServiceUnavailableException(
        'El servicio de lectura de documentos no está configurado',
      );
    if (options.dryRun) return this.simular(distributorId, params);
    const turno = await this.redis.withLock(
      `document-reading:corrida:${distributorId}`,
      CERROJO_CORRIDA_TTL_MS,
      () => this.correr(distributorId, params),
    );
    if (!turno.obtenido)
      throw new ConflictException(
        'Ya hay una lectura de documentos en curso para esta distribuidora: esperá a que termine',
      );
    return turno.valor;
  }

  /** Lo que leería ahora, respetando el tope del mes, sin bajar ni leer nada. */
  private async simular(
    distributorId: string,
    params: Awaited<ReturnType<DocumentReadingSettingsService['parametros']>>,
  ): Promise<DocumentReadingRunResult> {
    const pending = await this.queue.pendientes(
      distributorId,
      params.batchSize,
      params.maxAttempts,
      params.typesMask,
    );
    const { costoUsd, lecturas } =
      await this.readings.gastoDelMes(distributorId);
    const estimado = costoEstimado(costoUsd, lecturas);
    const caben = Math.max(
      0,
      Math.floor((params.monthlyBudgetUsd - costoUsd) / estimado),
    );
    const read = Math.min(pending.length, caben);
    return {
      ...EMPTY,
      distributors: 1,
      read,
      budgetReached: read < pending.length ? 1 : 0,
    };
  }

  private async correr(
    distributorId: string,
    params: Awaited<ReturnType<DocumentReadingSettingsService['parametros']>>,
  ): Promise<DocumentReadingRunResult> {
    const pending = await this.queue.pendientes(
      distributorId,
      params.batchSize,
      params.maxAttempts,
      params.typesMask,
    );
    const result = { ...EMPTY, distributors: 1 };
    for (const attachment of pending) {
      const spend = await this.readings.gastoDelMes(distributorId);
      // No empieza una lectura que, por lo que cuesta en promedio, pasaría el tope.
      if (
        spend.costoUsd + costoEstimado(spend.costoUsd, spend.lecturas) >
        params.monthlyBudgetUsd
      ) {
        result.budgetReached += 1;
        break;
      }
      try {
        const owner = DOCUMENT_READING_OWNERS.find(
          (o) => o.ownerType === attachment.ownerType,
        );
        const buffer = await this.s3.get(attachment.storageKey);
        const reading = await this.readings.leerAdjunto({
          distributorId,
          attachmentId: attachment.attachmentId,
          archivo: { buffer, mimeType: attachment.mimeType },
          opciones: owner?.expectedType
            ? { tipoEsperado: owner.expectedType }
            : undefined,
        });
        const status = reading.registro.status;
        try {
          // Con el módulo apagado (corrida manual) no se propone: nadie la vencería.
          // El barrido la toma cuando se encienda.
          if (params.enabled)
            await this.proposals.procesarLectura(reading.registro);
        } catch (conciliacion) {
          // La lectura ya quedó guardada: un fallo al cruzarla no la vuelve fallida.
          registrarErrorAtrapado(conciliacion);
          this.logger.warn(
            `Conciliación de la lectura ${reading.registro.readingId} falló: ${errorMessage(conciliacion)}`,
          );
        }
        switch (status) {
          case DocumentReadingStatus.READ:
          case DocumentReadingStatus.UNREADABLE:
            result.read += 1;
            break;
          case DocumentReadingStatus.DUPLICATE:
            result.duplicates += 1;
            break;
          case DocumentReadingStatus.FAILED:
            result.failed += 1;
            break;
          case DocumentReadingStatus.PENDING:
            result.skipped += 1;
            break;
        }
      } catch (error) {
        if (error instanceof ConflictException) {
          // Otro pedido (el escaneo al subir) lo está leyendo: no es un fallo.
          result.skipped += 1;
          continue;
        }
        result.failed += 1;
        registrarErrorAtrapado(error);
        this.logger.warn(
          `Lectura de adjunto ${attachment.attachmentId} falló: ${errorMessage(error)}`,
        );
        try {
          await this.readings.registrarFalloPrevio({
            distributorId,
            attachmentId: attachment.attachmentId,
            motivo: motivoDelFallo(error),
          });
        } catch (registro) {
          registrarErrorAtrapado(registro);
        }
      }
    }
    return result;
  }
}

/** El motivo que ve el administrador: sin detalles técnicos del almacenamiento. */
function motivoDelFallo(error: unknown): string {
  const texto = errorMessage(error);
  if (/specified key does not exist|NoSuchKey|NotFound/i.test(texto)) {
    return 'El archivo no está en el almacenamiento: subilo de nuevo';
  }
  return 'No se pudo leer el documento: se reintenta en la próxima corrida';
}

/** Costo estimado de la próxima lectura: el promedio del mes, o uno por omisión. */
export function costoEstimado(gastoDelMes: number, lecturas: number): number {
  return lecturas > 0 ? gastoDelMes / lecturas : COSTO_ESTIMADO_POR_OMISION_USD;
}
