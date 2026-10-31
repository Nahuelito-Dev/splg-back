import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoCredentialsService } from '../../distributor/mercadopago-credentials.service';
import { MercadoPagoAdapter } from './mercadopago.adapter';

/**
 * La firma del webhook con el validador REAL del SDK (sin simularlo): lo que
 * manda Mercado Pago es `x-signature: ts=<ms>,v1=<HMAC-SHA256>` sobre el
 * manifiesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, firmado con el
 * secreto de la aplicación (`MP_WEBHOOK_SECRET`).
 */
describe('MercadoPagoAdapter: firma del webhook (validador real)', () => {
  const SECRETO = 'secreto-de-prueba';
  let adapter: MercadoPagoAdapter;

  beforeEach(() => {
    adapter = new MercadoPagoAdapter(
      {
        get: (k: string) => (k === 'MP_WEBHOOK_SECRET' ? SECRETO : ''),
      } as unknown as ConfigService,
      {
        resolveById: (_id: unknown, sistema: object) =>
          Promise.resolve({
            ...sistema,
            source: 'system',
            credentialId: null,
            distributorId: null,
          }),
      } as unknown as MercadoPagoCredentialsService,
    );
  });

  const firmar = (dataId: string, requestId: string, secreto = SECRETO) => {
    const ts = String(Date.now());
    const hash = createHmac('sha256', secreto)
      .update(`id:${dataId};request-id:${requestId};ts:${ts};`)
      .digest('hex');
    return `ts=${ts},v1=${hash}`;
  };

  it('acepta la firma calculada con el secreto configurado', async () => {
    await expect(
      adapter.verifyWebhookSignature({
        xSignature: firmar('123456', 'req-1'),
        xRequestId: 'req-1',
        dataId: '123456',
      }),
    ).resolves.toBe(true);
  });

  it('rechaza una firma hecha con otro secreto', async () => {
    await expect(
      adapter.verifyWebhookSignature({
        xSignature: firmar('123456', 'req-1', 'otro-secreto'),
        xRequestId: 'req-1',
        dataId: '123456',
      }),
    ).resolves.toBe(false);
  });

  it('rechaza si cambia el id del pago, el request-id o falta el header', async () => {
    const xSignature = firmar('123456', 'req-1');
    await expect(
      adapter.verifyWebhookSignature({
        xSignature,
        xRequestId: 'req-1',
        dataId: '999',
      }),
    ).resolves.toBe(false);
    await expect(
      adapter.verifyWebhookSignature({
        xSignature,
        xRequestId: 'req-2',
        dataId: '123456',
      }),
    ).resolves.toBe(false);
    await expect(
      adapter.verifyWebhookSignature({
        xRequestId: 'req-1',
        dataId: '123456',
      }),
    ).resolves.toBe(false);
  });
});
