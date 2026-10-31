import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import type { DataSource } from 'typeorm';
import type { AttachmentService } from '../../attachment/attachment.service';
import { RoleType } from '../../common/constants/role-type.enum';
import type { S3CleanupService } from '../../s3/s3-cleanup.service';
import type { S3Service } from '../../s3/s3.service';
import { MpReconciliationStatus } from '../domain/mp-reconciliation.enums';
import {
  MercadoPagoReportsPort,
  MpReportRef,
  MpReportsError,
} from '../domain/mp-reports.port';
import type { PagoDelLibro } from '../domain/reconciliation';
import { CSV_LIBERACIONES } from '../testing/liberaciones-ejemplo';
import { MpReconciliationItem } from '../entities/mp-reconciliation-item.entity';
import { MpReconciliation } from '../entities/mp-reconciliation.entity';
import type { MpLedgerReader } from './mp-ledger.reader';
import {
  MpContexto,
  MpReconciliationService,
} from './mp-reconciliation.service';

const DIST = 'dist-1';
const ADMIN: MpContexto = {
  distributorId: DIST,
  userId: 'adm-1',
  role: RoleType.ADMIN,
};
const SUPER: MpContexto = { ...ADMIN, role: RoleType.SUPER_ADMIN };

const pago = (id: string, extra: Partial<PagoDelLibro> = {}): PagoDelLibro => ({
  paymentId: `pay-${id}`,
  orderId: `ord-${id}`,
  gatewayPaymentId: id,
  ingreso: null,
  comision: null,
  devolucionComprometida: new Decimal(0),
  ...extra,
});

function corridaBase(
  cambios: Partial<MpReconciliation> = {},
): MpReconciliation {
  return {
    reconciliationId: 'rec-1',
    distributorId: DIST,
    requestedByUserId: 'adm-1',
    fromDate: '2026-10-01',
    toDate: '2026-10-10',
    status: MpReconciliationStatus.REQUESTED,
    includeAccountLevel: false,
    mpReportId: null,
    fileName: null,
    failureReason: null,
    summary: null,
    accountReportKey: null,
    reportAttachmentId: null,
    lastCheckedAt: null,
    readyAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...cambios,
  };
}

const referencia = (cambios: Partial<MpReportRef> = {}): MpReportRef => ({
  id: '777',
  fileName: 'release-report-777.csv',
  status: 'processed',
  beginDate: new Date('2026-10-01T03:00:00Z'),
  endDate: new Date('2026-10-11T02:59:59Z'),
  generationDate: new Date(),
  ...cambios,
});

describe('MpReconciliationService', () => {
  let service: MpReconciliationService;
  let corrida: MpReconciliation | null;
  let guardadas: MpReconciliation[];
  let insertados: Array<Record<string, unknown>>;
  let items: MpReconciliationItem[];
  let repetida: boolean;
  let reclamable: boolean;
  let orden: string[];
  let manager: Record<string, jest.Mock>;
  let reportes: {
    requestReport: jest.Mock;
    listReports: jest.Mock;
    downloadReport: jest.Mock;
  };
  let libro: jest.Mocked<
    Pick<
      MpLedgerReader,
      'pagosDeLosIds' | 'ingresosDelRango' | 'movimientosDeLaCaja'
    >
  >;
  let adjuntos: { upload: jest.Mock; getSignedDownload: jest.Mock };
  let storage: {
    put: jest.Mock<Promise<void>, [{ key: string; body: Buffer }]>;
    getSignedDownload: jest.Mock;
  };
  let cleanup: { reserveUpload: jest.Mock; confirmUpload: jest.Mock };

  beforeEach(() => {
    corrida = null;
    guardadas = [];
    insertados = [];
    items = [];
    repetida = false;
    reclamable = true;
    orden = [];
    const qb: Record<string, jest.Mock> = {};
    for (const m of ['setLock', 'setOnLocked', 'where']) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getOne = jest.fn(() => Promise.resolve(corrida));
    manager = {
      exists: jest.fn(() => Promise.resolve(repetida)),
      create: jest.fn((_e: unknown, datos: Partial<MpReconciliation>) =>
        corridaBase({ reconciliationId: 'rec-nueva', ...datos }),
      ),
      save: jest.fn((c: MpReconciliation) => {
        guardadas.push({ ...c });
        return Promise.resolve(c);
      }),
      insert: jest.fn((_e: unknown, filas: Array<Record<string, unknown>>) => {
        insertados.push(...filas);
        return Promise.resolve();
      }),
      findOne: jest.fn((entidad: unknown) =>
        Promise.resolve(
          entidad === MpReconciliation
            ? corrida
            : { mercadoPagoCashBoxId: 'wallet-1' },
        ),
      ),
      find: jest.fn((entidad: unknown, opciones: Record<string, unknown>) =>
        Promise.resolve(
          entidad === MpReconciliationItem
            ? items.filter(
                (i) =>
                  (opciones.where as { accountLevel?: boolean })
                    .accountLevel === undefined || !i.accountLevel,
              )
            : corrida
              ? [corrida]
              : [],
        ),
      ),
      findAndCount: jest.fn(() =>
        Promise.resolve([corrida ? [corrida] : [], corrida ? 1 : 0]),
      ),
      query: jest.fn((sql: string) =>
        Promise.resolve(
          /UPDATE "mp_reconciliation"/.test(sql)
            ? reclamable
              ? [[{ reconciliation_id: 'rec-1' }], 1]
              : [[], 0]
            : [],
        ),
      ),
      update: jest.fn(
        (
          _e: unknown,
          _criterio: unknown,
          cambios: Partial<MpReconciliation>,
        ) => {
          if (corrida) Object.assign(corrida, cambios);
          return Promise.resolve();
        },
      ),
      createQueryBuilder: jest.fn(() => qb),
    };
    const dataSource = {
      manager,
      transaction: jest.fn((cb: (m: typeof manager) => unknown) => {
        orden.push('transaccion');
        return cb(manager);
      }),
    } as unknown as DataSource;
    reportes = {
      requestReport: jest
        .fn()
        .mockResolvedValue({ reportId: '777', beginDate: null, endDate: null }),
      listReports: jest.fn().mockResolvedValue([]),
      downloadReport: jest.fn(() => {
        orden.push('descarga');
        return Promise.resolve(CSV_LIBERACIONES);
      }),
    };
    libro = {
      pagosDeLosIds: jest.fn().mockResolvedValue({
        propios: new Map([
          [
            '1001',
            pago('1001', {
              ingreso: {
                cashBoxId: 'wallet-1',
                amount: new Decimal(1000),
                occurredAt: new Date(),
              },
              comision: new Decimal(50),
            }),
          ],
          ['1002', pago('1002')],
        ]),
        ajenos: new Set(['8888']),
        sinDistribuidora: new Set(),
      }),
      ingresosDelRango: jest.fn().mockResolvedValue([]),
      movimientosDeLaCaja: jest.fn().mockResolvedValue({
        income: new Decimal(1000),
        expense: new Decimal(50),
      }),
    };
    adjuntos = {
      upload: jest.fn(() => {
        orden.push('subida');
        return Promise.resolve({ attachmentId: 'adj-1' });
      }),
      getSignedDownload: jest
        .fn()
        .mockResolvedValue({ url: 'https://s3/adjunto', expiresAt: null }),
    };
    storage = {
      put: jest.fn<Promise<void>, [{ key: string; body: Buffer }]>(() =>
        Promise.resolve(),
      ),
      getSignedDownload: jest
        .fn()
        .mockResolvedValue({ url: 'https://s3/completo', expiresAt: null }),
    };
    cleanup = {
      reserveUpload: jest.fn().mockResolvedValue(undefined),
      confirmUpload: jest.fn().mockResolvedValue(undefined),
    };
    service = new MpReconciliationService(
      dataSource,
      reportes as unknown as MercadoPagoReportsPort,
      libro as unknown as MpLedgerReader,
      adjuntos as unknown as AttachmentService,
      storage as unknown as S3Service,
      cleanup as unknown as S3CleanupService,
    );
  });

  describe('crear', () => {
    it('crea la corrida y pide el reporte del rango completo en hora argentina', async () => {
      const c = await service.crear(
        { from: '2026-10-01', to: '2026-10-10' },
        ADMIN,
      );

      expect(reportes.requestReport).toHaveBeenCalledWith({
        from: new Date('2026-10-01T03:00:00Z'),
        to: new Date('2026-10-11T02:59:59Z'),
        distributorId: 'dist-1',
      });
      expect(c.status).toBe(MpReconciliationStatus.REQUESTED);
      expect(c.mpReportId).toBe('777');
      expect(c.distributorId).toBe(DIST);
      expect(c.includeAccountLevel).toBe(false);
    });

    it('la corrida de un super admin incluye lo de la cuenta', async () => {
      const c = await service.crear(
        { from: '2026-10-01', to: '2026-10-10' },
        SUPER,
      );

      expect(c.includeAccountLevel).toBe(true);
    });

    it.each([
      [{ from: '2026-10-10', to: '2026-10-01' }, /anterior/],
      [{ from: '2026-08-01', to: '2026-10-01' }, /31 días/],
      [{ from: '2999-01-01', to: '2999-01-02' }, /futura/],
    ])('rechaza el rango %j', async (dto, mensaje) => {
      await expect(service.crear(dto, ADMIN)).rejects.toThrow(mensaje);
      expect(reportes.requestReport).not.toHaveBeenCalled();
    });

    it('acepta exactamente 31 días', async () => {
      await expect(
        service.crear({ from: '2026-09-01', to: '2026-10-01' }, ADMIN),
      ).resolves.toBeDefined();
    });

    it('no repite una corrida pedida para el mismo rango que sigue esperando', async () => {
      repetida = true;

      await expect(
        service.crear({ from: '2026-10-01', to: '2026-10-10' }, ADMIN),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it.each([
      ['rejected', BadRequestException],
      ['timeout', GatewayTimeoutException],
      ['not_configured', ServiceUnavailableException],
      ['unauthorized', BadGatewayException],
      ['unavailable', BadGatewayException],
    ] as const)(
      'si Mercado Pago falla (%s) la corrida queda fallida y el error se traduce',
      async (kind, excepcion) => {
        reportes.requestReport.mockRejectedValue(
          new MpReportsError(kind, 'MP dijo que no'),
        );

        await expect(
          service.crear({ from: '2026-10-01', to: '2026-10-10' }, ADMIN),
        ).rejects.toBeInstanceOf(excepcion);

        const ultima = guardadas[guardadas.length - 1];
        expect(ultima.status).toBe(MpReconciliationStatus.FAILED);
        expect(ultima.failureReason).toBe('MP dijo que no');
      },
    );

    it('si Mercado Pago armó el reporte para otro rango, la corrida falla y no se concilia', async () => {
      reportes.requestReport.mockResolvedValue({
        reportId: '9',
        beginDate: new Date('2026-09-20T03:00:00Z'),
        endDate: new Date('2026-10-11T02:59:59Z'),
      });

      await expect(
        service.crear({ from: '2026-10-01', to: '2026-10-10' }, ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(guardadas[guardadas.length - 1].failureReason).toMatch(
        /otro rango/,
      );
    });

    it('un error que no es de Mercado Pago sube tal cual', async () => {
      reportes.requestReport.mockRejectedValue(new Error('boom'));

      await expect(
        service.crear({ from: '2026-10-01', to: '2026-10-10' }, ADMIN),
      ).rejects.toThrow('boom');
    });
  });

  describe('sincronizar', () => {
    beforeEach(() => {
      corrida = corridaBase({ mpReportId: '777' });
    });

    it('no hace nada si la corrida no existe, la tomó otra instancia o ya no está pendiente', async () => {
      reclamable = false;
      await service.sincronizar('rec-1');

      expect(reportes.listReports).not.toHaveBeenCalled();
    });

    it('mientras Mercado Pago no lo generó queda pendiente y anota la consulta', async () => {
      reportes.listReports.mockResolvedValue([
        referencia({ status: 'pending', fileName: null }),
      ]);

      await service.sincronizar('rec-1');

      expect(corrida?.status).toBe(MpReconciliationStatus.REQUESTED);
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE "mp_reconciliation"'),
        ['rec-1'],
      );
      expect(reportes.downloadReport).not.toHaveBeenCalled();
    });

    it('si el reporte no figura todavía en la lista, sigue pendiente', async () => {
      reportes.listReports.mockResolvedValue([
        referencia({ id: '1', beginDate: new Date('2026-09-01T03:00:00Z') }),
      ]);
      corrida = corridaBase({ mpReportId: '999' });

      await service.sincronizar('rec-1');

      expect(corrida.status).toBe(MpReconciliationStatus.REQUESTED);
    });

    it('con el reporte listo lo baja, concilia, guarda las diferencias y el comprobante', async () => {
      reportes.listReports.mockResolvedValue([referencia()]);

      await service.sincronizar('rec-1');

      expect(corrida?.status).toBe(MpReconciliationStatus.READY);
      expect(corrida?.readyAt).toBeInstanceOf(Date);
      expect(corrida?.fileName).toBe('release-report-777.csv');
      expect(reportes.downloadReport).toHaveBeenCalledWith(
        'release-report-777.csv',
        'dist-1',
      );
      const tipos = insertados.map((i) => i.kind);
      expect(tipos).toContain('payment_not_in_cash');
      expect(insertados.every((i) => i.accountLevel === false)).toBe(true);
      expect(insertados.every((i) => i.status === 'pending')).toBe(true);
      expect(adjuntos.upload).toHaveBeenCalledTimes(1);
      const [dueno, id, dist, archivo, , actor] = adjuntos.upload.mock
        .calls[0] as [
        string,
        string,
        string,
        { buffer: Buffer },
        string,
        unknown,
      ];
      expect([dueno, id, dist]).toEqual(['mp_reconciliation', 'rec-1', DIST]);
      const filtrado = archivo.buffer.toString('utf8');
      expect(filtrado).toContain('1001');
      expect(filtrado).not.toContain('8888');
      expect(filtrado).not.toContain('9001');
      expect(actor).toEqual({ userId: 'adm-1', role: RoleType.ADMIN });
      expect(corrida?.reportAttachmentId).toBe('adj-1');
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('el resumen compara lo de Mercado Pago con la caja', async () => {
      reportes.listReports.mockResolvedValue([referencia()]);

      await service.sincronizar('rec-1');

      expect(corrida?.summary).toMatchObject({
        rows: 2,
        mp: { gross: 3000, fees: 150, taxes: 0, net: 2850 },
        cash: { income: 1000, expense: 50, net: 950 },
        differences: { payment_not_in_cash: 1 },
        alreadyApplied: 0,
        unreadableRows: 0,
      });
      expect(corrida?.summary?.account).toBeUndefined();
    });

    it('la corrida de un super admin suma lo de la cuenta y guarda el archivo completo', async () => {
      corrida = corridaBase({ mpReportId: '777', includeAccountLevel: true });
      reportes.listReports.mockResolvedValue([referencia()]);

      await service.sincronizar('rec-1');

      const tipos = insertados.map((i) => i.kind);
      expect(tipos).toEqual(
        expect.arrayContaining(['payout', 'tax_row', 'unknown_payment']),
      );
      expect(
        insertados.filter((i) => i.accountLevel === true).length,
      ).toBeGreaterThan(0);
      expect(corrida?.summary?.account).toBeDefined();
      expect(storage.put).toHaveBeenCalledTimes(1);
      const subido = storage.put.mock.calls[0][0];
      expect(subido.body.toString('utf8')).toContain('9001');
      expect(corrida?.accountReportKey).toBe(subido.key);
      expect(cleanup.reserveUpload).toHaveBeenCalledWith(subido.key);
      expect(cleanup.confirmUpload).toHaveBeenCalledWith(manager, subido.key);
    });

    it('si S3 falla, la corrida no se da por lista, el motivo es el propio y no se filtra el error interno', async () => {
      reportes.listReports.mockResolvedValue([referencia()]);
      adjuntos.upload.mockRejectedValue(
        new Error('S3 caído: password=secreto'),
      );

      await service.sincronizar('rec-1');

      expect(corrida?.status).toBe(MpReconciliationStatus.REQUESTED);
      expect(corrida?.failureReason).toMatch(/No se pudo procesar el reporte/);
      expect(corrida?.failureReason).not.toMatch(/secreto/);
    });

    it('descarga, parseo y subidas ocurren antes de abrir la transacción: nada de HTTP ni S3 con la corrida bloqueada', async () => {
      corrida = corridaBase({ mpReportId: '777', includeAccountLevel: true });
      reportes.listReports.mockResolvedValue([referencia()]);

      await service.sincronizar('rec-1');

      expect(orden[0]).toBe('descarga');
      expect(orden.indexOf('subida')).toBeLessThan(
        orden.indexOf('transaccion'),
      );
      expect(orden.slice(0, orden.indexOf('transaccion'))).toEqual(
        expect.arrayContaining(['descarga', 'subida']),
      );
    });

    it('si guardar el resultado falla, el reintento no vuelve a subir el reporte', async () => {
      reportes.listReports.mockResolvedValue([referencia()]);
      manager.insert.mockRejectedValueOnce(new Error('base caída'));

      await service.sincronizar('rec-1');
      await service.sincronizar('rec-1');

      expect(adjuntos.upload).toHaveBeenCalledTimes(1);
      expect(corrida?.status).toBe(MpReconciliationStatus.READY);
      expect(corrida?.reportAttachmentId).toBe('adj-1');
    });

    it('si Mercado Pago informa que el reporte falló, la corrida falla', async () => {
      reportes.listReports.mockResolvedValue([
        referencia({ status: 'failed', fileName: null }),
      ]);

      await service.sincronizar('rec-1');

      expect(corrida?.status).toBe(MpReconciliationStatus.FAILED);
      expect(corrida?.failureReason).toMatch(/no pudo generar/);
    });

    it('un reporte sin las columnas necesarias falla con un motivo legible', async () => {
      reportes.listReports.mockResolvedValue([referencia()]);
      reportes.downloadReport.mockResolvedValue('Fecha,Monto\n1,2');

      await service.sincronizar('rec-1');

      expect(corrida?.status).toBe(MpReconciliationStatus.FAILED);
      expect(corrida?.failureReason).toMatch(/SOURCE_ID/);
    });

    it.each(['timeout', 'unavailable', 'rate_limited'] as const)(
      'un error pasajero (%s) deja la corrida pendiente para reintentar',
      async (kind) => {
        reportes.listReports.mockRejectedValue(new MpReportsError(kind, 'x'));

        await service.sincronizar('rec-1');

        expect(corrida?.status).toBe(MpReconciliationStatus.REQUESTED);
      },
    );

    it.each(['unauthorized', 'not_configured', 'invalid_response'] as const)(
      'un error que no se arregla solo (%s) da la corrida por fallida',
      async (kind) => {
        reportes.listReports.mockRejectedValue(
          new MpReportsError(kind, 'credencial'),
        );

        await service.sincronizar('rec-1');

        expect(corrida?.status).toBe(MpReconciliationStatus.FAILED);
        expect(corrida?.failureReason).toBe('credencial');
      },
    );

    it('falla al bajar el archivo: error pasajero la deja pendiente', async () => {
      reportes.listReports.mockResolvedValue([referencia()]);
      reportes.downloadReport.mockRejectedValue(
        new MpReportsError('timeout', 'lento'),
      );

      await service.sincronizar('rec-1');

      expect(corrida?.status).toBe(MpReconciliationStatus.REQUESTED);
    });

    it('un error propio no corta a quien consulta: queda anotado y la corrida sigue pendiente', async () => {
      reportes.listReports.mockRejectedValue(new Error('boom'));

      await expect(service.sincronizar('rec-1')).resolves.toBeUndefined();

      expect(corrida?.status).toBe(MpReconciliationStatus.REQUESTED);
      expect(corrida?.failureReason).toMatch(/Se reintenta/);
    });

    it('si Mercado Pago no lo generó en 24 horas, la corrida falla', async () => {
      corrida = corridaBase({
        createdAt: new Date(Date.now() - 25 * 60 * 60_000),
      });

      await service.sincronizar('rec-1');

      expect(corrida.status).toBe(MpReconciliationStatus.FAILED);
      expect(corrida.failureReason).toMatch(/24 horas/);
      expect(reportes.listReports).not.toHaveBeenCalled();
    });

    it('sin id de Mercado Pago, elige el reporte por las fechas pedidas, el más reciente', async () => {
      corrida = corridaBase({ mpReportId: null });
      reportes.listReports.mockResolvedValue([
        referencia({
          id: 'viejo',
          fileName: 'viejo.csv',
          generationDate: new Date(Date.now() - 3 * 60 * 60_000),
        }),
        referencia({
          id: 'otro-rango',
          fileName: 'otro.csv',
          beginDate: new Date('2026-09-01T03:00:00Z'),
        }),
        referencia({ id: 'nuevo', fileName: 'nuevo.csv' }),
      ]);

      await service.sincronizar('rec-1');

      expect(reportes.downloadReport).toHaveBeenCalledWith(
        'nuevo.csv',
        'dist-1',
      );
      expect(corrida?.mpReportId).toBe('nuevo');
    });
  });

  describe('detalle', () => {
    it('una corrida pendiente consulta a Mercado Pago antes de responder', async () => {
      corrida = corridaBase({ mpReportId: '777' });
      reportes.listReports.mockResolvedValue([
        referencia({ status: 'pending', fileName: null }),
      ]);

      const r = await service.detalle('rec-1', ADMIN);

      expect(reportes.listReports).toHaveBeenCalledTimes(1);
      expect(r.corrida.status).toBe(MpReconciliationStatus.REQUESTED);
    });

    it('no consulta de nuevo si se acaba de mirar', async () => {
      corrida = corridaBase({ lastCheckedAt: new Date() });

      await service.detalle('rec-1', ADMIN);

      expect(reportes.listReports).not.toHaveBeenCalled();
    });

    it('la distribuidora no ve las diferencias de la cuenta; el super admin sí', async () => {
      corrida = corridaBase({ status: MpReconciliationStatus.READY });
      items = [
        { itemId: 'a', accountLevel: false },
        { itemId: 'b', accountLevel: true },
      ] as MpReconciliationItem[];
      manager.find.mockImplementation(
        (entidad: unknown, op: { where: { accountLevel?: boolean } }) =>
          Promise.resolve(
            entidad === MpReconciliationItem
              ? items.filter((i) =>
                  op.where.accountLevel === false ? !i.accountLevel : true,
                )
              : [],
          ),
      );

      expect((await service.detalle('rec-1', ADMIN)).items).toHaveLength(1);
      expect((await service.detalle('rec-1', SUPER)).items).toHaveLength(2);
    });

    it('404 si la corrida no es de la distribuidora', async () => {
      corrida = null;

      await expect(service.detalle('rec-x', ADMIN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('enlaceDelReporte', () => {
    it('el super admin que pidió la corrida baja el completo de la cuenta', async () => {
      corrida = corridaBase({
        status: MpReconciliationStatus.READY,
        includeAccountLevel: true,
        accountReportKey: 'mp-reconciliations/x.csv',
        reportAttachmentId: 'adj-1',
      });

      const r = await service.enlaceDelReporte('rec-1', SUPER);

      expect(r.url).toBe('https://s3/completo');
      expect(adjuntos.getSignedDownload).not.toHaveBeenCalled();
    });

    it('la distribuidora baja el adjunto filtrado, aunque la corrida tenga el completo', async () => {
      corrida = corridaBase({
        status: MpReconciliationStatus.READY,
        includeAccountLevel: true,
        accountReportKey: 'mp-reconciliations/x.csv',
        reportAttachmentId: 'adj-1',
      });

      const r = await service.enlaceDelReporte('rec-1', ADMIN);

      expect(r.url).toBe('https://s3/adjunto');
      expect(storage.getSignedDownload).not.toHaveBeenCalled();
    });

    it('404 mientras el reporte no está guardado', async () => {
      corrida = corridaBase();

      await expect(
        service.enlaceDelReporte('rec-1', ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('listar y idsPendientes consultan sólo lo de la distribuidora y lo pendiente', async () => {
    corrida = corridaBase();

    const lista = await service.listar(ADMIN, {
      status: MpReconciliationStatus.READY,
      page: 2,
      limit: 5,
    });
    const ids = await service.idsPendientes();

    expect(lista.total).toBe(1);
    expect(manager.findAndCount).toHaveBeenCalledWith(
      MpReconciliation,
      expect.objectContaining({
        where: { distributorId: DIST, status: 'ready' },
        skip: 5,
        take: 5,
      }),
    );
    expect(ids).toEqual(['rec-1']);
  });
});
