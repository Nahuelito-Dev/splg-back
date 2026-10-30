import { ConfigService } from '@nestjs/config';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MercadoPagoReportsPort } from '../domain/mp-reports.port';
import { MpReconciliationModule } from '../mp-reconciliation.module';
import { FakeMercadoPagoReportsAdapter } from './fake-mercadopago-reports.adapter';
import { MercadoPagoReportsAdapter } from './mercadopago-reports.adapter';

describe('FakeMercadoPagoReportsAdapter', () => {
  it('cada pedido genera un reporte ya listo y el archivo sale del CSV indicado', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-fake-'));
    const ruta = join(dir, 'reporte.csv');
    writeFileSync(ruta, 'DATE,SOURCE_ID\n1,2\n');
    const adapter = new FakeMercadoPagoReportsAdapter({
      get: jest.fn().mockReturnValue(ruta),
    } as unknown as ConfigService);

    const { reportId } = await adapter.requestReport({
      from: new Date('2026-10-01T03:00:00Z'),
      to: new Date('2026-10-02T02:59:59Z'),
    });
    const [ref] = await adapter.listReports();

    expect(ref).toMatchObject({ id: reportId, status: 'processed' });
    expect(await adapter.downloadReport()).toBe('DATE,SOURCE_ID\n1,2\n');
  });

  it('sin CSV configurado devuelve sólo el encabezado', async () => {
    const adapter = new FakeMercadoPagoReportsAdapter({
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService);

    expect(await adapter.downloadReport()).toMatch(
      /^DATE;TRANSACTION_APPROVAL_DATE;SOURCE_ID/,
    );
  });
});

describe('MpReconciliationModule: elección del adaptador', () => {
  type Fabrica = (c: ConfigService) => MercadoPagoReportsPort;

  const fabrica = (): Fabrica => {
    const proveedores = Reflect.getMetadata(
      'providers',
      MpReconciliationModule,
    ) as Array<{ provide?: unknown; useFactory?: Fabrica }>;
    const proveedor = proveedores.find(
      (p) => p.provide === MercadoPagoReportsPort,
    );
    if (!proveedor?.useFactory)
      throw new Error('el módulo no tiene la fábrica');
    return proveedor.useFactory;
  };
  const config = (env: Record<string, string>) =>
    ({ get: (k: string) => env[k] }) as unknown as ConfigService;

  it('por omisión usa el adaptador real', () => {
    expect(fabrica()(config({}))).toBeInstanceOf(MercadoPagoReportsAdapter);
    expect(fabrica()(config({ MP_REPORTS_DRIVER: 'real' }))).toBeInstanceOf(
      MercadoPagoReportsAdapter,
    );
  });

  it('con MP_REPORTS_DRIVER=fake usa el de mentira', () => {
    expect(
      fabrica()(config({ MP_REPORTS_DRIVER: 'fake', NODE_ENV: 'development' })),
    ).toBeInstanceOf(FakeMercadoPagoReportsAdapter);
  });

  it.each(['production', 'staging', undefined])(
    'con NODE_ENV=%s el adaptador de mentira no arranca',
    (entorno) => {
      expect(() =>
        fabrica()(
          config({
            MP_REPORTS_DRIVER: 'fake',
            ...(entorno ? { NODE_ENV: entorno } : {}),
          }),
        ),
      ).toThrow('sólo se admite con NODE_ENV=development o test');
    },
  );

  it('cada pedido del adaptador de mentira tiene un id único', async () => {
    const adapter = new FakeMercadoPagoReportsAdapter(config({}));
    const pedido = { from: new Date(), to: new Date() };

    const a = await adapter.requestReport(pedido);
    const b = await adapter.requestReport(pedido);

    expect(a.reportId).not.toBe(b.reportId);
  });
});
