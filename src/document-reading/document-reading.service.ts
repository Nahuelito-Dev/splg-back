import { createHash } from 'crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

import {
  ArchivoDeDocumento,
  DocumentReaderPort,
  LecturaDeDocumento,
  OpcionesDeLectura,
} from '../document-reader/document-reader.port';
import { TipoDeDocumento } from '../document-reader/tipos-de-documento';
import { RedisService } from '../redis/redis.service';
import {
  DocumentReading,
  DocumentReadingStatus,
  ESTADOS_LEIDOS,
} from './entities/document-reading.entity';

export interface DocumentoALeer {
  distributorId: string;
  attachmentId: string;
  archivo: ArchivoDeDocumento;
  opciones?: OpcionesDeLectura;
}

export interface ResultadoDeLectura {
  registro: DocumentReading;
  /** Lo leído (o copiado del original si es un duplicado); null si no se pudo leer. */
  lectura: LecturaDeDocumento | null;
}

export interface FiltroDeLecturas {
  status?: DocumentReadingStatus;
  type?: TipoDeDocumento;
  limit: number;
  offset: number;
}

/**
 * Cerrojo por distribuidora y huella del archivo: dos subidas del mismo archivo
 * (al mismo adjunto o a dos distintos) no se leen ni se cobran dos veces; la
 * segunda espera y reusa lo que leyó la primera.
 */
const CERROJO_TTL_MS = 60_000;
const CERROJO_ESPERA_MS = 45_000;

/** Los estados que sirven de original para un duplicado: leídos y no duplicados. */
const ORIGINALES = ESTADOS_LEIDOS.filter(
  (e) => e !== DocumentReadingStatus.DUPLICATE,
);

/**
 * Las lecturas de documentos del módulo M6: cada adjunto se lee una sola vez,
 * el mismo archivo subido dos veces no se vuelve a leer (ni a pagar) y queda
 * registrado lo que se extrajo y lo que costó.
 */
@Injectable()
export class DocumentReadingService {
  private readonly logger = new Logger(DocumentReadingService.name);

  constructor(
    @InjectRepository(DocumentReading)
    private readonly repo: Repository<DocumentReading>,
    private readonly lector: DocumentReaderPort,
    private readonly redis: RedisService,
  ) {}

  get disponible(): boolean {
    return this.lector.disponible;
  }

  /**
   * Lee el adjunto y guarda el resultado. Si ya se leyó, devuelve esa lectura
   * sin volver a llamar al servicio; si es el mismo archivo que otro adjunto ya
   * leído, lo marca como duplicado y copia sus datos.
   */
  async leerAdjunto(documento: DocumentoALeer): Promise<ResultadoDeLectura> {
    const huella = createHash('sha256')
      .update(documento.archivo.buffer)
      .digest('hex');
    const turno = await this.redis.withLock(
      `document-reading:${documento.distributorId}:${huella}`,
      CERROJO_TTL_MS,
      () => this.leerConCerrojo(documento, huella),
      CERROJO_ESPERA_MS,
    );
    if (!turno.obtenido) {
      throw new ConflictException(
        'El documento se está leyendo en este momento: reintentá en unos segundos',
      );
    }
    return turno.valor;
  }

  private async leerConCerrojo(
    documento: DocumentoALeer,
    huella: string,
  ): Promise<ResultadoDeLectura> {
    const { distributorId, attachmentId, archivo, opciones } = documento;
    const existente = await this.repo.findOne({
      where: { attachmentId, distributorId },
    });
    if (existente && ESTADOS_LEIDOS.includes(existente.status)) {
      return { registro: existente, lectura: this.comoLectura(existente) };
    }

    const original = await this.repo.findOne({
      where: {
        distributorId,
        fileSha256: huella,
        status: In(ORIGINALES),
        attachmentId: Not(attachmentId),
      },
      order: { readAt: 'ASC' },
    });
    if (existente) existente.fileSha256 = huella;
    const registro =
      existente ??
      this.repo.create({
        distributorId,
        attachmentId,
        fileSha256: huella,
        expectedType: opciones?.tipoEsperado ?? null,
        // `create` no trae los valores por omisión de la base: van explícitos.
        status: DocumentReadingStatus.PENDING,
        fields: [],
        warnings: [],
        duplicateOfId: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        attempts: 0,
        lastError: null,
        proposal: null,
        proposalExpiresAt: null,
        remindedAt: null,
        escalatedAt: null,
        readAt: null,
      });

    if (original) {
      Object.assign(registro, {
        status: DocumentReadingStatus.DUPLICATE,
        duplicateOfId: original.readingId,
        detectedType: original.detectedType,
        legible: original.legible,
        fields: original.fields,
        warnings: [
          `Este documento ya se había cargado el ${fechaCorta(original.readAt)}: se usan los datos de esa lectura`,
          ...original.warnings,
        ],
        readAt: new Date(),
        lastError: null,
      });
      const guardado = await this.repo.save(registro);
      return { registro: guardado, lectura: this.comoLectura(guardado) };
    }

    if (!this.lector.disponible) {
      const guardado = await this.repo.save(registro);
      return { registro: guardado, lectura: null };
    }

    registro.attempts += 1;
    const lectura = await this.lector.leer(archivo, opciones);
    if (!lectura) {
      Object.assign(registro, {
        status: DocumentReadingStatus.FAILED,
        lastError: 'El servicio de lectura no devolvió un resultado',
      });
      const guardado = await this.repo.save(registro);
      return { registro: guardado, lectura: null };
    }

    Object.assign(registro, {
      status: lectura.legible
        ? DocumentReadingStatus.READ
        : DocumentReadingStatus.UNREADABLE,
      detectedType: lectura.tipo,
      legible: lectura.legible,
      fields: lectura.campos,
      warnings: lectura.avisos,
      model: lectura.uso.modelo,
      inputTokens: registro.inputTokens + lectura.uso.tokensDeEntrada,
      outputTokens: registro.outputTokens + lectura.uso.tokensDeSalida,
      costUsd: Number(
        (Number(registro.costUsd) + lectura.uso.costoUsd).toFixed(6),
      ),
      readAt: new Date(),
      lastError: null,
    });
    const guardado = await this.repo.save(registro);
    this.logger.log(
      `Lectura ${guardado.readingId}: ${lectura.tipo}, ${lectura.campos.length} campos, US$ ${lectura.uso.costoUsd}`,
    );
    return { registro: guardado, lectura };
  }

  /**
   * Un adjunto que no se pudo ni empezar a leer (el archivo no está en el
   * almacenamiento, no se pudo bajar): queda fallido con su intento y el motivo,
   * para que la cola lo deje al agotar los intentos y no trabe a los demás.
   */
  async registrarFalloPrevio(fallo: {
    distributorId: string;
    attachmentId: string;
    motivo: string;
  }): Promise<DocumentReading> {
    const { distributorId, attachmentId, motivo } = fallo;
    const existente = await this.repo.findOne({
      where: { attachmentId, distributorId },
    });
    if (existente && ESTADOS_LEIDOS.includes(existente.status))
      return existente;
    const registro =
      existente ??
      this.repo.create({
        distributorId,
        attachmentId,
        // Sin el archivo no hay huella: ceros hasta que se lea de verdad.
        fileSha256: '0'.repeat(64),
        expectedType: null,
        fields: [],
        warnings: [],
        duplicateOfId: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        attempts: 0,
        readAt: null,
      });
    registro.status = DocumentReadingStatus.FAILED;
    registro.attempts += 1;
    registro.lastError = motivo.slice(0, 500);
    return this.repo.save(registro);
  }

  async listar(
    distributorId: string,
    filtro: FiltroDeLecturas,
  ): Promise<{ data: DocumentReading[]; total: number }> {
    const [data, total] = await this.repo.findAndCount({
      where: {
        distributorId,
        ...(filtro.status ? { status: filtro.status } : {}),
        ...(filtro.type ? { detectedType: filtro.type } : {}),
      },
      order: { createdAt: 'DESC', readingId: 'ASC' },
      take: filtro.limit,
      skip: filtro.offset,
    });
    return { data, total };
  }

  async obtener(
    readingId: string,
    distributorId: string,
  ): Promise<DocumentReading> {
    const lectura = await this.repo.findOne({
      where: { readingId, distributorId },
      relations: { attachment: true },
    });
    if (!lectura) throw new NotFoundException('Lectura no encontrada');
    return lectura;
  }

  /** Lo que se gastó en lecturas en el mes calendario de `fecha` (hora de Argentina). */
  async gastoDelMes(
    distributorId: string,
    fecha: Date = new Date(),
  ): Promise<{ lecturas: number; costoUsd: number }> {
    const fila = await this.repo
      .createQueryBuilder('r')
      .select('COUNT(*) FILTER (WHERE r.input_tokens > 0)', 'lecturas')
      .addSelect('COALESCE(SUM(r.cost_usd), 0)', 'costo')
      .where('r.distributor_id = :distributorId', { distributorId })
      // El mes en que se leyó (y se pagó), no el de la subida.
      .andWhere(
        `date_trunc('month', r.read_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = date_trunc('month', CAST(:fecha AS timestamptz) AT TIME ZONE 'America/Argentina/Buenos_Aires')`,
        { fecha: fecha.toISOString() },
      )
      .getRawOne<{ lecturas: string; costo: string }>();
    return {
      lecturas: Number(fila?.lecturas ?? 0),
      costoUsd: Number(Number(fila?.costo ?? 0).toFixed(6)),
    };
  }

  private comoLectura(r: DocumentReading): LecturaDeDocumento | null {
    if (!r.detectedType) return null;
    return {
      tipo: r.detectedType,
      legible: r.legible ?? false,
      campos: r.fields,
      avisos: r.warnings,
      uso: {
        modelo: r.model ?? '',
        tokensDeEntrada:
          r.status === DocumentReadingStatus.DUPLICATE ? 0 : r.inputTokens,
        tokensDeSalida:
          r.status === DocumentReadingStatus.DUPLICATE ? 0 : r.outputTokens,
        costoUsd:
          r.status === DocumentReadingStatus.DUPLICATE ? 0 : Number(r.costUsd),
      },
    };
  }
}

function fechaCorta(fecha: Date | null): string {
  if (!fecha) return 'antes';
  return fecha.toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
  });
}
