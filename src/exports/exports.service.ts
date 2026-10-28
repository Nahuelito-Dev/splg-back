import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassThrough, Readable } from 'node:stream';
import { diaArgentino } from '../common/utils/dias-argentina';
import { ExportSourcesRegistry } from './export-sources.registry';
import {
  type Celda,
  type ConsultaDeExporte,
  ExportFormat,
  type LoteDeFilas,
} from './export.types';
import { streamCsv } from './writers/csv-export.writer';
import { escribirXlsx } from './writers/xlsx-export.writer';

/** Filas que se piden por vez al listado de origen. */
export const TAMANO_DE_LOTE = 500;
/** Tope por defecto de filas por exporte (`EXPORT_MAX_ROWS`). */
export const MAXIMO_DE_FILAS_POR_DEFECTO = 50_000;

const TIPO_DE_CONTENIDO: Record<ExportFormat, string> = {
  [ExportFormat.CSV]: 'text/csv; charset=utf-8',
  [ExportFormat.XLSX]:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Un exporte listo para enviar: ya se validó todo y ya se leyó el primer lote. */
export interface ExporteListo {
  nombreDeArchivo: string;
  tipoDeContenido: string;
  total: number;
  cuerpo: Readable;
}

@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly registry: ExportSourcesRegistry,
    private readonly config: ConfigService,
  ) {}

  recursos(): string[] {
    return this.registry.recursos();
  }

  /** El tope de filas, configurable con `EXPORT_MAX_ROWS`. */
  maximoDeFilas(): number {
    const valor = Number(this.config.get('EXPORT_MAX_ROWS'));
    return Number.isInteger(valor) && valor > 0
      ? valor
      : MAXIMO_DE_FILAS_POR_DEFECTO;
  }

  /**
   * Valida el pedido y lee el primer lote. Todo lo que puede fallar por culpa
   * del cliente (recurso, formato, filtros, tope) falla acá, antes de que se
   * escriba el primer byte de la respuesta.
   */
  async preparar(
    recurso: string,
    parametros: Record<string, unknown>,
    distribuidoraId: string,
    signal?: AbortSignal,
  ): Promise<ExporteListo> {
    const fuente = this.registry.buscar(recurso);
    if (!fuente) {
      throw new NotFoundException(
        `No existe el recurso «${recurso}». Disponibles: ${this.recursos().join(', ')}`,
      );
    }
    const { format, ...filtros } = parametros;
    const formato = this.formatoDe(format);

    const consulta = await fuente.preparar(filtros, distribuidoraId);
    const maximo = this.maximoDeFilas();
    const primero = await consulta.leer(0, TAMANO_DE_LOTE);
    this.verificarTope(primero, maximo);

    const lotes = this.lotes(consulta, primero, maximo, signal);
    const extension = formato;
    const cuerpo =
      formato === ExportFormat.CSV
        ? streamCsv(fuente.encabezados, lotes)
        : this.streamXlsx(fuente.encabezados, lotes, signal);

    return {
      nombreDeArchivo: `${fuente.recurso}-${diaArgentino()}.${extension}`,
      tipoDeContenido: TIPO_DE_CONTENIDO[formato],
      total: primero.total,
      cuerpo,
    };
  }

  private formatoDe(valor: unknown): ExportFormat {
    if (valor === undefined) return ExportFormat.CSV;
    if (valor === ExportFormat.CSV || valor === ExportFormat.XLSX) return valor;
    throw new BadRequestException('format debe ser csv o xlsx');
  }

  private verificarTope(lote: LoteDeFilas, maximo: number): void {
    const filas = Math.max(lote.total, lote.filas.length);
    if (filas > maximo) {
      throw new BadRequestException(
        `El exporte tiene ${filas} filas y el máximo es ${maximo}. Acotá los filtros (por ejemplo, el rango de fechas).`,
      );
    }
  }

  /** El primer lote ya leído y los que siguen, de a `TAMANO_DE_LOTE`. */
  private async *lotes(
    consulta: ConsultaDeExporte,
    primero: LoteDeFilas,
    maximo: number,
    signal?: AbortSignal,
  ): AsyncGenerator<Celda[][]> {
    let lote = primero;
    let desde = 0;
    for (;;) {
      if (lote.filas.length > 0) yield lote.filas;
      desde += TAMANO_DE_LOTE;
      if (!consulta.paginada || lote.filas.length === 0 || desde >= lote.total)
        return;
      if (signal?.aborted) {
        this.logger.warn(
          `Exporte cortado: el cliente cerró la conexión (se leyeron ${desde} filas)`,
        );
        return;
      }
      lote = await consulta.leer(desde, TAMANO_DE_LOTE);
      this.verificarTope(lote, maximo);
    }
  }

  private streamXlsx(
    encabezados: Parameters<typeof escribirXlsx>[1],
    lotes: AsyncIterable<Celda[][]>,
    signal?: AbortSignal,
  ): Readable {
    const salida = new PassThrough();
    escribirXlsx(salida, encabezados, lotes, signal).catch((error: unknown) => {
      this.logger.error(
        `Falló la escritura del Excel: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return salida;
  }
}
