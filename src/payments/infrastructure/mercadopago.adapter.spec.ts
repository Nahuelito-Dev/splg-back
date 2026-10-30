import { ConfigService } from '@nestjs/config';
import { MercadoPagoAdapter } from './mercadopago.adapter';

const crearReintegro = jest.fn();
const obtenerPago = jest.fn();

/** El SDK se simula entero: ningún test de acá llega a MercadoPago. */
jest.mock('mercadopago', () => ({
  MercadoPagoConfig: jest.fn(),
  Preference: jest.fn(),
  WebhookSignatureValidator: { validate: jest.fn() },
  Payment: jest.fn().mockImplementation(() => ({
    get: (...args: unknown[]): unknown => obtenerPago(...args),
  })),
  PaymentRefund: jest.fn().mockImplementation(() => ({
    create: (...args: unknown[]): unknown => crearReintegro(...args),
  })),
}));

describe('MercadoPagoAdapter (SDK simulado)', () => {
  let adapter: MercadoPagoAdapter;

  beforeEach(() => {
    adapter = new MercadoPagoAdapter({
      get: jest.fn().mockReturnValue('token'),
    } as unknown as ConfigService);
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
