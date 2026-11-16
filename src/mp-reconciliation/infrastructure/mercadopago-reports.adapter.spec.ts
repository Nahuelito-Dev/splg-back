import { ConfigService } from '@nestjs/config';
import { MercadoPagoCredentialsService } from '../../distributor/mercadopago-credentials.service';
import { MpReportsError } from '../domain/mp-reports.port';
import {
  estadoDelReporte,
  formatoDeMp,
  MercadoPagoReportsAdapter,
} from './mercadopago-reports.adapter';

const respuesta = (status: number, cuerpo = ''): Response =>
  new Response(cuerpo, { status });

/** `fetch` se simula entero: ningún test de acá llega a Mercado Pago. */
describe('MercadoPagoReportsAdapter (fetch simulado)', () => {
  let fetchMock: jest.SpyInstance;
  let adapter: MercadoPagoReportsAdapter;

  const resolve = jest.fn();
  const crear = (token: string | null = 'token-de-prueba') =>
    new MercadoPagoReportsAdapter(
      { get: jest.fn().mockReturnValue(token) } as unknown as ConfigService,
      { resolve } as unknown as MercadoPagoCredentialsService,
    );

  beforeEach(() => {
    resolve.mockReset();
    resolve.mockImplementation(
      (_id: string | null, sistema: { accessToken: string }) =>
        Promise.resolve({ ...sistema, source: 'system' }),
    );
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('los tests no salen a la red'));
    adapter = crear();
  });

  it('pide el reporte con el rango en ISO y el token global', async () => {
    fetchMock.mockResolvedValue(
      respuesta(
        202,
        '{"id":123,"begin_date":"2026-10-01T03:00:00Z","end_date":"2026-10-31T02:59:59Z"}',
      ),
    );

    const r = await adapter.requestReport({
      from: new Date('2026-10-01T03:00:00.000Z'),
      to: new Date('2026-10-31T02:59:59.000Z'),
    });

    expect(r).toEqual({
      reportId: '123',
      beginDate: new Date('2026-10-01T03:00:00Z'),
      endDate: new Date('2026-10-31T02:59:59Z'),
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mercadopago.com/v1/account/release_report');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      begin_date: '2026-10-01T03:00:00Z',
      end_date: '2026-10-31T02:59:59Z',
    });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-de-prueba',
    );
  });

  it('acepta una respuesta 202 sin cuerpo', async () => {
    fetchMock.mockResolvedValue(respuesta(202));

    await expect(
      adapter.requestReport({ from: new Date(), to: new Date() }),
    ).resolves.toEqual({ reportId: null, beginDate: null, endDate: null });
  });

  it('un 203 significa que Mercado Pago no creó el reporte', async () => {
    fetchMock.mockResolvedValue(respuesta(203, '{}'));

    await expect(
      adapter.requestReport({ from: new Date(), to: new Date() }),
    ).rejects.toMatchObject({ kind: 'rejected', httpStatus: 203 });
  });

  it('lista los reportes normalizando estado y fechas', async () => {
    fetchMock.mockResolvedValue(
      respuesta(
        200,
        JSON.stringify([
          {
            id: 99336983670,
            file_name: 'release-report-1.csv',
            status: 'processed',
            begin_date: '2026-10-01T03:00:00Z',
            end_date: '2026-10-08T02:59:59Z',
            generation_date: '2026-10-09T15:55:22.258-04:00',
          },
          { id: 2, status: 'pending', begin_date: 'nada' },
          'basura',
        ]),
      ),
    );

    const lista = await adapter.listReports();

    expect(lista).toHaveLength(2);
    expect(lista[0]).toMatchObject({
      id: '99336983670',
      fileName: 'release-report-1.csv',
      status: 'processed',
    });
    expect(lista[0].beginDate?.toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(lista[1]).toMatchObject({
      fileName: null,
      status: 'pending',
      beginDate: null,
    });
  });

  it('una lista que no es un arreglo es una respuesta inválida', async () => {
    fetchMock.mockResolvedValue(respuesta(200, '{"a":1}'));

    await expect(adapter.listReports()).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('baja el archivo por su nombre, escapado', async () => {
    fetchMock.mockResolvedValue(respuesta(200, 'DATE,SOURCE_ID\n'));

    const csv = await adapter.downloadReport('release report/1.csv');

    expect(csv).toBe('DATE,SOURCE_ID\n');
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://api.mercadopago.com/v1/account/release_report/release%20report%2F1.csv',
    );
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [400, 'rejected'],
    [404, 'rejected'],
  ])('HTTP %s es un error %s', async (status, kind) => {
    fetchMock.mockResolvedValue(respuesta(status, '{}'));

    await expect(adapter.listReports()).rejects.toMatchObject({
      kind,
      httpStatus: status,
    });
  });

  it('distingue el timeout de un corte de red', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('t'), { name: 'TimeoutError' }),
    );
    await expect(adapter.listReports()).rejects.toMatchObject({
      kind: 'timeout',
    });

    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(adapter.listReports()).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('una respuesta que no es JSON es inválida', async () => {
    fetchMock.mockResolvedValue(respuesta(200, '<html>'));

    await expect(adapter.listReports()).rejects.toBeInstanceOf(MpReportsError);
  });

  it('con cuenta propia de la distribuidora pide el reporte con su token, no con el global', async () => {
    resolve.mockResolvedValue({
      accessToken: 'token-propio',
      webhookSecret: 's',
      source: 'own',
    });
    fetchMock.mockResolvedValue(respuesta(200, '[]'));

    await adapter.listReports('dist-1');

    expect(resolve).toHaveBeenCalledWith('dist-1', {
      accessToken: 'token-de-prueba',
      webhookSecret: '',
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer token-propio',
    });
  });

  it('si no se puede resolver la cuenta de la distribuidora (clave de cifrado) falla como MpReportsError, para que la corrida quede fallada', async () => {
    resolve.mockRejectedValue(new Error('falta CREDENTIALS_ENCRYPTION_KEY'));

    await expect(
      adapter.requestReport({
        from: new Date('2026-10-01T03:00:00Z'),
        to: new Date('2026-10-02T02:59:59Z'),
        distributorId: 'dist-1',
      }),
    ).rejects.toMatchObject({
      kind: 'not_configured',
      message: 'falta CREDENTIALS_ENCRYPTION_KEY',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sin token no sale a la red', async () => {
    adapter = crear(null);

    await expect(adapter.listReports()).rejects.toMatchObject({
      kind: 'not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('formatoDeMp', () => {
  it('sin milisegundos: con ellos Mercado Pago responde 400 invalid_begin_date', () => {
    expect(formatoDeMp(new Date('2026-10-23T03:00:00.000Z'))).toBe(
      '2026-10-23T03:00:00Z',
    );
  });
});

describe('estadoDelReporte', () => {
  it.each([
    ['processed', 'processed'],
    ['PROCESSED', 'processed'],
    ['error', 'failed'],
    ['failed', 'failed'],
    ['cancelled', 'failed'],
    ['pending', 'pending'],
    ['processing', 'pending'],
    [undefined, 'pending'],
  ])('%s -> %s', (entrada, esperado) => {
    expect(estadoDelReporte(entrada)).toBe(esperado);
  });
});
