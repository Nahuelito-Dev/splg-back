import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import {
  MercadoPagoReportsPort,
  MpReportRef,
  MpReportRequest,
  MpReportRequested,
} from '../domain/mp-reports.port';

const ENCABEZADO =
  'DATE;TRANSACTION_APPROVAL_DATE;SOURCE_ID;DESCRIPTION;NET_CREDIT_AMOUNT;NET_DEBIT_AMOUNT;GROSS_AMOUNT;MP_FEE_AMOUNT;TAXES_AMOUNT;PAYMENT_METHOD;BUSINESS_UNIT;SUB_UNIT;BALANCE_AMOUNT;PAYMENT_METHOD_TYPE;PURCHASE_ID' +
  '\n';

/**
 * Reporte de liberaciones de mentira para probar el circuito sin tocar la
 * cuenta de Mercado Pago (`MP_REPORTS_DRIVER=fake`; el módulo lo rechaza en
 * producción). Cada pedido genera un reporte ya listo y el archivo es el CSV
 * que indique `MP_REPORTS_FAKE_CSV` (ruta); sin esa variable, uno vacío.
 */
@Injectable()
export class FakeMercadoPagoReportsAdapter extends MercadoPagoReportsPort {
  private readonly reportes: MpReportRef[] = [];

  constructor(private readonly config: ConfigService) {
    super();
  }

  requestReport(request: MpReportRequest): Promise<MpReportRequested> {
    const id = `fake-${randomUUID()}`;
    this.reportes.push({
      id,
      fileName: `release-report-${id}.csv`,
      status: 'processed',
      beginDate: request.from,
      endDate: request.to,
      generationDate: new Date(),
    });
    return Promise.resolve({
      reportId: id,
      beginDate: request.from,
      endDate: request.to,
    });
  }

  listReports(): Promise<MpReportRef[]> {
    return Promise.resolve([...this.reportes]);
  }

  async downloadReport(): Promise<string> {
    const ruta = this.config.get<string>('MP_REPORTS_FAKE_CSV');
    return ruta ? readFile(ruta, 'utf8') : ENCABEZADO;
  }
}
