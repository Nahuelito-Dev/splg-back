import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MercadoPagoReportsPort,
  MpReportRef,
  MpReportRequest,
  MpReportRequested,
  MpReportsError,
  MpReportStatus,
} from '../domain/mp-reports.port';

/** Base de la API de Mercado Pago y ruta del reporte de liberaciones. */
const BASE_URL = 'https://api.mercadopago.com/v1/account/release_report';

/** Timeout de las consultas (pedir, listar). */
const TIMEOUT_MS = 15_000;
/** El archivo puede pesar: más aire para bajarlo. */
const TIMEOUT_DESCARGA_MS = 60_000;

type Json = Record<string, unknown>;

const esObjeto = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const texto = (v: unknown): string | null =>
  typeof v === 'string' && v !== ''
    ? v
    : typeof v === 'number'
      ? String(v)
      : null;

function fecha(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const f = new Date(v);
  return Number.isNaN(f.getTime()) ? null : f;
}

/**
 * Fecha como la acepta Mercado Pago: `YYYY-MM-DDTHH:mm:ssZ`, sin milisegundos (con ellos
 * responde 400 `invalid_begin_date`). Redondea al día de la cuenta (UTC-3): el día argentino
 * `D` se pide con `DT03:00:00Z`.
 */
export const formatoDeMp = (f: Date): string =>
  f.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Estado de Mercado Pago a los tres que usa el sistema; lo desconocido sigue pendiente. */
export function estadoDelReporte(status: unknown): MpReportStatus {
  const s = typeof status === 'string' ? status.toLowerCase() : '';
  if (s === 'processed' || s === 'ready' || s === 'finished') {
    return 'processed';
  }
  if (/error|fail|cancel/.test(s)) return 'failed';
  return 'pending';
}

/**
 * Adaptador HTTP de los reportes de liberaciones de Mercado Pago.
 * Doc: https://www.mercadopago.com.ar/developers/en/docs/reports/released-money/api
 * (crear: POST /v1/account/release_report; lista: GET .../list;
 * archivo: GET .../{file_name}). Credencial global `MP_ACCESS_TOKEN`.
 */
@Injectable()
export class MercadoPagoReportsAdapter extends MercadoPagoReportsPort {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async requestReport(request: MpReportRequest): Promise<MpReportRequested> {
    const respuesta = await this.llamar(BASE_URL, {
      method: 'POST',
      body: JSON.stringify({
        begin_date: formatoDeMp(request.from),
        end_date: formatoDeMp(request.to),
      }),
    });
    if (respuesta.status === 203) {
      throw new MpReportsError(
        'rejected',
        'Mercado Pago no pudo crear el reporte para esas fechas: probá con otro rango',
        203,
      );
    }
    const cuerpo = await this.leerJson(respuesta);
    if (!esObjeto(cuerpo)) {
      return { reportId: null, beginDate: null, endDate: null };
    }
    return {
      reportId: texto(cuerpo.id),
      beginDate: fecha(cuerpo.begin_date),
      endDate: fecha(cuerpo.end_date),
    };
  }

  async listReports(): Promise<MpReportRef[]> {
    const respuesta = await this.llamar(`${BASE_URL}/list`, { method: 'GET' });
    const cuerpo = await this.leerJson(respuesta);
    if (!Array.isArray(cuerpo)) {
      throw new MpReportsError(
        'invalid_response',
        'Mercado Pago devolvió una lista de reportes con un formato inesperado',
      );
    }
    return cuerpo.filter(esObjeto).map((r) => ({
      id: texto(r.id),
      fileName: texto(r.file_name),
      status: estadoDelReporte(r.status),
      beginDate: fecha(r.begin_date),
      endDate: fecha(r.end_date),
      generationDate: fecha(r.generation_date),
    }));
  }

  async downloadReport(fileName: string): Promise<string> {
    const respuesta = await this.llamar(
      `${BASE_URL}/${encodeURIComponent(fileName)}`,
      { method: 'GET' },
      TIMEOUT_DESCARGA_MS,
    );
    return new TextDecoder('utf-8').decode(await respuesta.arrayBuffer());
  }

  private async llamar(
    url: string,
    init: { method: 'GET' | 'POST'; body?: string },
    timeoutMs = TIMEOUT_MS,
  ): Promise<Response> {
    const token = this.config.get<string>('MP_ACCESS_TOKEN');
    if (!token) {
      throw new MpReportsError(
        'not_configured',
        'Mercado Pago no está configurado en el servidor (falta MP_ACCESS_TOKEN)',
      );
    }
    let respuesta: Response;
    try {
      respuesta = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timeout =
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new MpReportsError(
        timeout ? 'timeout' : 'unavailable',
        timeout
          ? 'Mercado Pago no respondió a tiempo'
          : 'No se pudo comunicar con Mercado Pago',
      );
    }
    if (respuesta.ok) return respuesta;
    if (respuesta.status === 401 || respuesta.status === 403) {
      throw new MpReportsError(
        'unauthorized',
        'Mercado Pago rechazó la credencial del servidor',
        respuesta.status,
      );
    }
    if (respuesta.status === 429) {
      throw new MpReportsError(
        'rate_limited',
        'Mercado Pago pidió esperar antes de volver a consultar',
        429,
      );
    }
    if (respuesta.status >= 500) {
      throw new MpReportsError(
        'unavailable',
        'Mercado Pago no está disponible en este momento',
        respuesta.status,
      );
    }
    throw new MpReportsError(
      'rejected',
      `Mercado Pago rechazó el pedido (HTTP ${respuesta.status})`,
      respuesta.status,
    );
  }

  private async leerJson(respuesta: Response): Promise<unknown> {
    const cuerpo = await respuesta.text();
    if (cuerpo.trim() === '') return null;
    try {
      return JSON.parse(cuerpo) as unknown;
    } catch {
      throw new MpReportsError(
        'invalid_response',
        'Mercado Pago devolvió una respuesta que no es JSON',
        respuesta.status,
      );
    }
  }
}
