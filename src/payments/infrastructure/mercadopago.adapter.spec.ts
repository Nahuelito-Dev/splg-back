import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig } from 'mercadopago';
import { MercadoPagoCredentialsService } from '../../distributor/mercadopago-credentials.service';
import { fechaDeMercadoPago, MercadoPagoAdapter } from './mercadopago.adapter';

const crearReintegro = jest.fn();
const obtenerPago = jest.fn();
const crearPreferencia = jest.fn();
const validarFirma = jest.fn();

/** El SDK se simula entero: ningún test de acá llega a MercadoPago. */
jest.mock('mercadopago', () => ({
  MercadoPagoConfig: jest.fn(),
  Preference: jest.fn().mockImplementation(() => ({
    create: (...args: unknown[]): unknown => crearPreferencia(...args),
  })),
  WebhookSignatureValidator: {
    validate: (...args: unknown[]): unknown => validarFirma(...args),
  },
  Payment: jest.fn().mockImplementation(() => ({
    get: (...args: unknown[]): unknown => obtenerPago(...args),
  })),
  PaymentRefund: jest.fn().mockImplementation(() => ({
    create: (...args: unknown[]): unknown => crearReintegro(...args),
  })),
}));

describe('MercadoPagoAdapter (SDK simulado)', () => {
  let adapter: MercadoPagoAdapter;
  const resolve = jest.fn();
  const resolveById = jest.fn();
  const entorno: Record<string, string> = {
    MP_ACCESS_TOKEN: 'token-del-entorno',
    MP_WEBHOOK_SECRET: 'secreto-del-entorno',
    MP_NOTIFICATION_URL: 'https://api.splg.test/api/webhook/mercadopago',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    const delSistema = (
      _id: string | null,
      sistema: { accessToken: string; webhookSecret: string },
    ) =>
      Promise.resolve({
        ...sistema,
        source: 'system',
        credentialId: null,
        distributorId: null,
      });
    resolve.mockImplementation(delSistema);
    resolveById.mockImplementation(delSistema);
    adapter = new MercadoPagoAdapter(
      { get: (k: string) => entorno[k] } as unknown as ConfigService,
      { resolve, resolveById } as unknown as MercadoPagoCredentialsService,
    );
  });

  const cuerpoDeLaPreferencia = (): { notification_url?: string } =>
    (
      crearPreferencia.mock.calls[0] as [
        { body: { notification_url?: string } },
      ]
    )[0].body;

  const cuentaPropia = (): void => {
    const propia = {
      accessToken: 'token-propio',
      webhookSecret: 'secreto-propio',
      source: 'own',
      credentialId: 'cred-1',
      distributorId: 'd1',
    };
    resolve.mockResolvedValue(propia);
    resolveById.mockResolvedValue(propia);
  };

  it('sin cuenta propia el checkout usa el token y la notification_url del entorno', async () => {
    crearPreferencia.mockResolvedValue({
      id: 'p1',
      init_point: 'https://mp/1',
    });

    await adapter.createCheckout({
      orderId: 'o1',
      items: [{ id: 'i', title: 't', quantity: 1, unitPrice: 10 }],
      payerEmail: 'a@b.c',
      distributorId: 'd1',
    });

    expect(MercadoPagoConfig).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'token-del-entorno' }),
    );
    expect(cuerpoDeLaPreferencia().notification_url).toBe(
      'https://api.splg.test/api/webhook/mercadopago',
    );
  });

  describe('vencimiento de la preferencia', () => {
    const crear = async (
      expiresAt?: Date,
    ): Promise<Record<string, unknown>> => {
      crearPreferencia.mockResolvedValue({
        id: 'p1',
        init_point: 'https://mp/1',
      });
      await adapter.createCheckout({
        orderId: 'o1',
        items: [{ id: 'i', title: 't', quantity: 1, unitPrice: 10 }],
        payerEmail: 'a@b.c',
        expiresAt,
      });
      return (
        crearPreferencia.mock.calls[0] as [{ body: Record<string, unknown> }]
      )[0].body;
    };

    it('con vencimiento la preferencia sale con expires y expiration_date_to en hora argentina', async () => {
      const body = await crear(new Date('2026-10-31T15:30:00.000Z'));
      expect(body.expires).toBe(true);
      expect(body.expiration_date_to).toBe('2026-10-31T12:30:00.000-03:00');
      expect(body.expiration_date_from).toEqual(
        expect.stringMatching(/-03:00$/),
      );
    });

    it('sin vencimiento no se manda ninguna fecha', async () => {
      const body = await crear();
      expect(body).not.toHaveProperty('expires');
      expect(body).not.toHaveProperty('expiration_date_to');
    });

    it('fechaDeMercadoPago cruza el día: 01:00 UTC es el día anterior a las 22:00 -03:00', () => {
      expect(fechaDeMercadoPago(new Date('2026-11-01T01:00:00.000Z'))).toBe(
        '2026-10-31T22:00:00.000-03:00',
      );
    });
  });

  it('con cuenta propia el checkout usa su token y marca la cuenta en la notification_url', async () => {
    cuentaPropia();
    crearPreferencia.mockResolvedValue({
      id: 'p1',
      init_point: 'https://mp/1',
    });

    await adapter.createCheckout({
      orderId: 'o1',
      items: [{ id: 'i', title: 't', quantity: 1, unitPrice: 10 }],
      payerEmail: 'a@b.c',
      distributorId: 'd1',
    });

    expect(MercadoPagoConfig).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'token-propio' }),
    );
    expect(cuerpoDeLaPreferencia().notification_url).toBe(
      'https://api.splg.test/api/webhook/mercadopago?account=cred-1',
    );
  });

  it('getPayment y refundPayment usan la cuenta con la que se cobró, aunque ya no esté activa', async () => {
    cuentaPropia();
    obtenerPago.mockResolvedValue({ id: 1 });
    crearReintegro.mockResolvedValue({ id: 2 });

    const pago = await adapter.getPayment('1', 'cred-1');
    await adapter.refundPayment({
      gatewayPaymentId: '1',
      amount: 5,
      idempotencyKey: 'k',
      credentialId: 'cred-1',
    });

    expect(pago.accountDistributorId).toBe('d1');
    expect(resolveById).toHaveBeenNthCalledWith(
      1,
      'cred-1',
      expect.any(Object),
    );
    expect(resolveById).toHaveBeenNthCalledWith(
      2,
      'cred-1',
      expect.any(Object),
    );
    expect(MercadoPagoConfig).toHaveBeenCalledTimes(2);
    expect(MercadoPagoConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ accessToken: 'token-propio' }),
    );
  });

  it('la firma del webhook se valida con el secreto de la cuenta de la notificación', async () => {
    cuentaPropia();
    validarFirma.mockReturnValue(undefined);

    const ok = await adapter.verifyWebhookSignature({
      xSignature: 'ts=1,v1=x',
      xRequestId: 'r',
      dataId: '9',
      credentialId: 'cred-1',
    });

    expect(ok).toBe(true);
    expect(validarFirma).toHaveBeenCalledWith(
      expect.objectContaining({ secret: 'secreto-propio' }),
    );
  });

  it('sin cuenta propia la firma se valida con el secreto del entorno', async () => {
    validarFirma.mockReturnValue(undefined);

    await adapter.verifyWebhookSignature({ dataId: '9' });

    expect(validarFirma).toHaveBeenCalledWith(
      expect.objectContaining({ secret: 'secreto-del-entorno' }),
    );
  });

  it('una firma que no cierra con el secreto elegido se rechaza', async () => {
    cuentaPropia();
    validarFirma.mockImplementation(() => {
      throw new Error('firma inválida');
    });

    expect(
      await adapter.verifyWebhookSignature({
        dataId: '9',
        credentialId: 'cred-1',
      }),
    ).toBe(false);
  });

  it('una cuenta que no existe rechaza la firma sin caer a otra cuenta', async () => {
    resolveById.mockRejectedValue(new Error('no existe'));

    expect(
      await adapter.verifyWebhookSignature({
        dataId: '9',
        credentialId: 'inexistente',
      }),
    ).toBe(false);
    expect(validarFirma).not.toHaveBeenCalled();
  });

  it('sin ningún secreto la firma se rechaza sin validar', async () => {
    delete entorno.MP_WEBHOOK_SECRET;

    expect(await adapter.verifyWebhookSignature({ dataId: '9' })).toBe(false);
    expect(validarFirma).not.toHaveBeenCalled();
    entorno.MP_WEBHOOK_SECRET = 'secreto-del-entorno';
  });

  it('refundPayment pide el importe con la clave de idempotencia y devuelve el id', async () => {
    crearReintegro.mockResolvedValue({ id: 987 });

    const r = await adapter.refundPayment({
      gatewayPaymentId: 'mp-1',
      amount: 1500,
      idempotencyKey: 'ref-1',
    });

    expect(crearReintegro).toHaveBeenCalledWith({
      payment_id: 'mp-1',
      body: { amount: 1500 },
      requestOptions: { idempotencyKey: 'ref-1' },
    });
    expect(r).toEqual({ refundId: '987' });
  });

  it('refundPayment falla si MercadoPago no devuelve el id', async () => {
    crearReintegro.mockResolvedValue({});

    await expect(
      adapter.refundPayment({
        gatewayPaymentId: 'mp-1',
        amount: 1,
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow(/id de la devolución/);
  });

  it('refundPayment propaga el rechazo de la pasarela', async () => {
    crearReintegro.mockRejectedValue(new Error('refund amount exceeds'));

    await expect(
      adapter.refundPayment({
        gatewayPaymentId: 'mp-1',
        amount: 1,
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow('refund amount exceeds');
  });

  it('getPayment informa lo cobrado y lo ya devuelto', async () => {
    obtenerPago.mockResolvedValue({
      id: 55,
      status: 'approved',
      external_reference: 'ord-1',
      transaction_amount: 3000,
      transaction_amount_refunded: 500,
    });

    expect(await adapter.getPayment('55')).toEqual({
      id: '55',
      status: 'approved',
      externalReference: 'ord-1',
      amount: 3000,
      refundedAmount: 500,
      feeAmount: null,
      accountDistributorId: null,
    });
  });

  it('getPayment informa la comisión: bruto menos neto recibido', async () => {
    obtenerPago.mockResolvedValue({
      id: 55,
      status: 'approved',
      transaction_amount: 3000,
      transaction_details: { net_received_amount: 2850.5 },
      fee_details: [
        { type: 'mercadopago_fee', amount: 100, fee_payer: 'collector' },
      ],
    });

    expect(await adapter.getPayment('55')).toMatchObject({ feeAmount: 149.5 });
  });

  it('getPayment suma los cargos del comercio cuando no hay neto, sin los del comprador', async () => {
    obtenerPago.mockResolvedValue({
      id: 55,
      status: 'approved',
      transaction_amount: 3000,
      fee_details: [
        { type: 'mercadopago_fee', amount: 100.25, fee_payer: 'collector' },
        { type: 'financing_fee', amount: 40, fee_payer: 'payer' },
      ],
    });

    expect(await adapter.getPayment('55')).toMatchObject({ feeAmount: 100.25 });
  });

  it('getPayment tolera que la pasarela no informe los importes', async () => {
    obtenerPago.mockResolvedValue({ id: 55 });

    expect(await adapter.getPayment('55')).toMatchObject({
      status: 'unknown',
      externalReference: null,
      amount: null,
      refundedAmount: null,
      feeAmount: null,
    });
  });
});
