import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig } from 'mercadopago';
import { MercadoPagoCredentialsService } from '../../distributor/mercadopago-credentials.service';
import {
  ADELANTO_DE_VIGENCIA_MINUTOS,
  ErrorDeLaPasarela,
  fechaDeMercadoPago,
  MercadoPagoAdapter,
  partirCalle,
  partirNombre,
  partirTelefono,
} from './mercadopago.adapter';

const crearReintegro = jest.fn();
const obtenerPago = jest.fn();
const buscarPagos = jest.fn();
const crearPreferencia = jest.fn();
const actualizarPreferencia = jest.fn();
const validarFirma = jest.fn();

/** El SDK se simula entero: ningún test de acá llega a MercadoPago. */
jest.mock('mercadopago', () => ({
  MercadoPagoConfig: jest.fn(),
  Preference: jest.fn().mockImplementation(() => ({
    create: (...args: unknown[]): unknown => crearPreferencia(...args),
    update: (...args: unknown[]): unknown => actualizarPreferencia(...args),
  })),
  WebhookSignatureValidator: {
    validate: (...args: unknown[]): unknown => validarFirma(...args),
  },
  Payment: jest.fn().mockImplementation(() => ({
    get: (...args: unknown[]): unknown => obtenerPago(...args),
    search: (...args: unknown[]): unknown => buscarPagos(...args),
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
      payer: { email: 'a@b.c' },
      distributorId: 'd1',
    });

    expect(MercadoPagoConfig).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'token-del-entorno' }),
    );
    expect(cuerpoDeLaPreferencia().notification_url).toBe(
      'https://api.splg.test/api/webhook/mercadopago?source_news=webhooks',
    );
  });

  describe('preferencia completa', () => {
    interface Cuerpo {
      items: Array<{ description: string }>;
      back_urls: { success: string; failure: string };
      [clave: string]: unknown;
    }

    const crear = async (
      extra: Partial<Parameters<MercadoPagoAdapter['createCheckout']>[0]> = {},
    ): Promise<Cuerpo> => {
      crearPreferencia.mockResolvedValue({
        id: 'p1',
        init_point: 'https://mp/1',
      });
      await adapter.createCheckout({
        orderId: 'o1',
        items: [
          {
            id: 'g1',
            title: 'Garrafa 10 kg',
            quantity: 2,
            unitPrice: 15000,
          },
        ],
        payer: { email: 'a@b.c' },
        ...extra,
      });
      return (crearPreferencia.mock.calls[0] as [{ body: Cuerpo }])[0].body;
    };

    it('el payer lleva nombre, apellido, email, teléfono y dirección', async () => {
      const body = await crear({
        payer: {
          email: 'ana@test.com',
          fullName: 'Ana María Pérez',
          phone: '+5491155551234',
          address: { street: 'Av. Colón 1234', zipCode: '5000' },
        },
      });

      expect(body.payer).toEqual({
        email: 'ana@test.com',
        name: 'Ana María',
        surname: 'Pérez',
        phone: { area_code: '11', number: '55551234' },
        address: {
          street_name: 'Av. Colón',
          street_number: '1234',
          zip_code: '5000',
        },
      });
    });

    it('sin email no manda email vacío: el payer queda sin esa clave', async () => {
      const body = await crear({ payer: { email: null, fullName: 'Ana' } });

      expect(body.payer).toEqual({ name: 'Ana' });
      expect(JSON.stringify(body)).not.toContain('"email":""');
    });

    it('sin ningún dato del comprador el payer va vacío', async () => {
      expect((await crear({ payer: { email: '' } })).payer).toEqual({});
    });

    it('shipments.receiver_address lleva la dirección de entrega', async () => {
      const body = await crear({
        receiverAddress: {
          street: 'San Martín 450',
          zipCode: '3300',
          floor: '2',
          apartment: 'B',
          city: 'Posadas',
        },
      });

      expect(body.shipments).toEqual({
        receiver_address: {
          street_name: 'San Martín',
          street_number: '450',
          zip_code: '3300',
          floor: '2',
          apartment: 'B',
          city_name: 'Posadas',
          country_name: 'Argentina',
        },
      });
    });

    it('sin dirección de entrega no manda shipments', async () => {
      expect(await crear()).not.toHaveProperty('shipments');
    });

    it('cada ítem lleva id, title, description, category_id, quantity y unit_price', async () => {
      const body = await crear();

      expect(body.items).toEqual([
        {
          id: 'g1',
          title: 'Garrafa 10 kg',
          description: 'Garrafa 10 kg',
          category_id: 'home',
          quantity: 2,
          unit_price: 15000,
          currency_id: 'ARS',
        },
      ]);
    });

    it('la descripción propia del ítem pisa al título', async () => {
      const body = await crear({
        items: [
          {
            id: 'g1',
            title: 'Garrafa',
            description: 'Garrafa de 10 kg, envase retornable',
            quantity: 1,
            unitPrice: 1,
          },
        ],
      });
      expect(body.items[0].description).toBe(
        'Garrafa de 10 kg, envase retornable',
      );
    });

    it('statement_descriptor sólo sale si se lo da', async () => {
      expect(
        (await crear({ statementDescriptor: 'JENY GAS' })).statement_descriptor,
      ).toBe('JENY GAS');
    });

    it('no ofrece ticket ni atm, una sola cuota y modo binario', async () => {
      const body = await crear();

      expect(body.payment_methods).toEqual({
        excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }],
        installments: 1,
      });
      expect(body.binary_mode).toBe(true);
    });

    it('back_urls apuntan al enlace profundo de la app y auto_return es approved', async () => {
      const body = await crear();

      expect(body.back_urls).toEqual({
        success: 'splg://pago/exito',
        pending: 'splg://pago/pendiente',
        failure: 'splg://pago/error',
      });
      expect(body.auto_return).toBe('approved');
    });

    it('MP_SUCCESS_URL, MP_PENDING_URL y MP_FAILURE_URL pisan los enlaces por defecto', async () => {
      entorno.MP_SUCCESS_URL =
        'https://api.splg.test/api/v2/payments/return?result=exito';
      const body = await crear();
      delete entorno.MP_SUCCESS_URL;

      expect(body.back_urls.success).toBe(
        'https://api.splg.test/api/v2/payments/return?result=exito',
      );
      expect(body.back_urls.failure).toBe('splg://pago/error');
    });
  });

  describe('datos del comprador para Mercado Pago', () => {
    it('partirNombre: el último término es el apellido', () => {
      expect(partirNombre('Juan')).toEqual({ name: 'Juan' });
      expect(partirNombre('  Juan   Carlos  Gómez ')).toEqual({
        name: 'Juan Carlos',
        surname: 'Gómez',
      });
      expect(partirNombre('')).toEqual({});
      expect(partirNombre(null)).toEqual({});
    });

    it('partirTelefono: móvil argentino con 11 y con área de 3 dígitos', () => {
      expect(partirTelefono('+5491155551234')).toEqual({
        area_code: '11',
        number: '55551234',
      });
      expect(partirTelefono('+5493764123456')).toEqual({
        area_code: '376',
        number: '4123456',
      });
    });

    it('partirTelefono: los códigos de área de 4 dígitos (Oberá 3755, Eldorado 3751) no se parten en 3', () => {
      expect(partirTelefono('+5493755412345')).toEqual({
        area_code: '3755',
        number: '412345',
      });
      expect(partirTelefono('+54 9 3751 45-6789')).toEqual({
        area_code: '3751',
        number: '456789',
      });
    });

    it('partirTelefono: otro país o formato raro va entero, y vacío es nada', () => {
      expect(partirTelefono('+59899123456')).toEqual({ number: '59899123456' });
      expect(partirTelefono('+54911')).toEqual({ number: '54911' });
      expect(partirTelefono('')).toBeUndefined();
      expect(partirTelefono(null)).toBeUndefined();
    });

    it('partirCalle: separa la altura sólo si está al final', () => {
      expect(partirCalle('Av. Colón 1234')).toEqual({
        street_name: 'Av. Colón',
        street_number: '1234',
      });
      expect(partirCalle('Ruta 12 km 1500')).toEqual({
        street_name: 'Ruta 12 km',
        street_number: '1500',
      });
      expect(partirCalle('Barrio Las Rosas')).toEqual({
        street_name: 'Barrio Las Rosas',
      });
    });
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
        payer: { email: 'a@b.c' },
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

    it('el inicio de la vigencia se adelanta unos minutos: el reloj de Mercado Pago no lo toma como futuro', async () => {
      const antes = Date.now();
      const body = await crear(new Date(antes + 60 * 60 * 1000));
      const desde = new Date(body.expiration_date_from as string).getTime();
      const adelanto = (antes - desde) / 60_000;
      // Unos minutos de margen (la fecha sale con segundos, no con milisegundos).
      expect(adelanto).toBeGreaterThanOrEqual(2.9);
      expect(adelanto).toBeLessThan(ADELANTO_DE_VIGENCIA_MINUTOS + 0.5);
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
      payer: { email: 'a@b.c' },
      distributorId: 'd1',
    });

    expect(MercadoPagoConfig).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'token-propio' }),
    );
    expect(cuerpoDeLaPreferencia().notification_url).toBe(
      'https://api.splg.test/api/webhook/mercadopago?source_news=webhooks&account=cred-1',
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

    expect(ok).toBe('valida');
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

  it('la firma no se valida por antigüedad del ts (unidad y reintentos sin confirmar en la doc)', async () => {
    validarFirma.mockReturnValue(undefined);

    await adapter.verifyWebhookSignature({ dataId: '9' });

    const opciones = validarFirma.mock.calls[0] as [Record<string, unknown>];
    expect(opciones[0]).not.toHaveProperty('toleranceSeconds');
  });

  describe('getChargeback', () => {
    afterEach(() => jest.restoreAllMocks());

    it('consulta el contracargo con el token de la cuenta y lo normaliza', async () => {
      cuentaPropia();
      const f = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'cb-1',
            payments: [123, '456'],
            amount: 15000,
            documentation_required: true,
            date_documentation_deadline: '2026-11-10T00:00:00.000-03:00',
            coverage_applied: true,
          }),
          { status: 200 },
        ),
      );

      const cb = await adapter.getChargeback('cb-1', 'cred-1');

      expect(f).toHaveBeenCalledWith(
        'https://api.mercadopago.com/v1/chargebacks/cb-1',
        expect.objectContaining({
          headers: { Authorization: 'Bearer token-propio' },
        }),
      );
      expect(cb).toEqual({
        id: 'cb-1',
        paymentIds: ['123', '456'],
        amount: 15000,
        documentationRequired: true,
        documentationDeadline: '2026-11-10T00:00:00.000-03:00',
        coverageApplied: true,
      });
    });

    it('el id del contracargo es el del aviso (texto): el de la respuesta pasa de 2^53 y se redondea', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          new Response(
            '{"id": 217000061307271000, "payments": [81034165129], "amount": 10}',
            { status: 200 },
          ),
        );

      const cb = await adapter.getChargeback('217000061307271001');

      expect(cb.id).toBe('217000061307271001');
    });

    it('el error lleva el código HTTP de Mercado Pago (para distinguir un 404 de una caída)', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 403 }));

      await expect(adapter.getChargeback('cb-9')).rejects.toMatchObject({
        status: 403,
      });
      await expect(adapter.getChargeback('cb-9')).rejects.toBeInstanceOf(
        ErrorDeLaPasarela,
      );
    });

    it('un error de Mercado Pago lanza, sin el token en el mensaje', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 404 }));

      await expect(adapter.getChargeback('cb-9')).rejects.toThrow(/404/);
      await expect(adapter.getChargeback('cb-9')).rejects.not.toThrow(
        /token-del-entorno/,
      );
    });
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
    ).toBe('invalida');
  });

  it('una cuenta que no existe es firma inválida: nadie de esa cuenta pudo firmar', async () => {
    resolveById.mockRejectedValue(new NotFoundException('no existe'));

    expect(
      await adapter.verifyWebhookSignature({
        dataId: '9',
        credentialId: 'inexistente',
      }),
    ).toBe('invalida');
    expect(validarFirma).not.toHaveBeenCalled();
  });

  it('si no se puede leer la cuenta (base caída) la firma NO se da por inválida: no es verificable', async () => {
    resolveById.mockRejectedValue(new Error('conexión perdida'));

    expect(
      await adapter.verifyWebhookSignature({
        dataId: '9',
        credentialId: 'cred-1',
      }),
    ).toBe('no_verificable');
    expect(validarFirma).not.toHaveBeenCalled();
  });

  it('sin ningún secreto la firma no se puede verificar y no se valida', async () => {
    delete entorno.MP_WEBHOOK_SECRET;

    expect(await adapter.verifyWebhookSignature({ dataId: '9' })).toBe(
      'no_verificable',
    );
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
      status_detail: 'partially_refunded',
      external_reference: 'ord-1',
      transaction_amount: 3000,
      transaction_amount_refunded: 500,
    });

    expect(await adapter.getPayment('55')).toEqual({
      id: '55',
      status: 'approved',
      statusDetail: 'partially_refunded',
      externalReference: 'ord-1',
      amount: 3000,
      refundedAmount: 500,
      feeAmount: null,
      accountDistributorId: null,
    });
  });

  it('findPaymentsByReference busca por external_reference con la cuenta indicada', async () => {
    buscarPagos.mockResolvedValue({
      results: [
        { id: 7, status: 'approved', external_reference: 'ord-1' },
        { id: 8, status: 'rejected', external_reference: 'ord-1' },
      ],
    });

    const pagos = await adapter.findPaymentsByReference('ord-1', 'cred-1');

    expect(resolveById).toHaveBeenCalledWith('cred-1', expect.anything());
    expect(buscarPagos).toHaveBeenCalledWith({
      options: expect.objectContaining({
        external_reference: 'ord-1',
      }) as object,
    });
    expect(pagos.map((p) => [p.id, p.status])).toEqual([
      ['7', 'approved'],
      ['8', 'rejected'],
    ]);
  });

  it('findPaymentsByReference deja pasar el error de la pasarela', async () => {
    buscarPagos.mockRejectedValue(new Error('timeout'));

    await expect(adapter.findPaymentsByReference('ord-1')).rejects.toThrow(
      'timeout',
    );
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

  it('M-6: un status_detail vacío o en blanco llega como null (no rompe el CHECK de la base)', async () => {
    obtenerPago.mockResolvedValue({
      id: 55,
      status: 'approved',
      status_detail: '',
    });
    expect((await adapter.getPayment('55')).statusDetail).toBeNull();
    obtenerPago.mockResolvedValue({
      id: 55,
      status: 'approved',
      status_detail: '  ',
    });
    expect((await adapter.getPayment('55')).statusDetail).toBeNull();
    obtenerPago.mockResolvedValue({
      id: 55,
      status: 'approved',
      status_detail: 'y'.repeat(300),
    });
    expect((await adapter.getPayment('55')).statusDetail).toHaveLength(100);
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

  describe('expireCheckout', () => {
    it('vence la preferencia ahora, con el token de la cuenta que la creó', async () => {
      cuentaPropia();
      actualizarPreferencia.mockResolvedValue({});

      await adapter.expireCheckout('pref-9', 'cred-1');

      expect(resolveById).toHaveBeenCalledWith('cred-1', expect.anything());
      expect(MercadoPagoConfig).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: 'token-propio' }),
      );
      const [pedido] = actualizarPreferencia.mock.calls[0] as [
        {
          id: string;
          updatePreferenceRequest: {
            expires: boolean;
            expiration_date_to: string;
          };
        },
      ];
      expect(pedido.id).toBe('pref-9');
      expect(pedido.updatePreferenceRequest.expires).toBe(true);
      const vence = new Date(
        pedido.updatePreferenceRequest.expiration_date_to,
      ).getTime();
      expect(Math.abs(vence - Date.now())).toBeLessThan(5000);
    });

    it('no toca los renglones de la preferencia (cambio parcial)', async () => {
      actualizarPreferencia.mockResolvedValue({});

      await adapter.expireCheckout('pref-9');

      const [pedido] = actualizarPreferencia.mock.calls[0] as [
        { updatePreferenceRequest: Record<string, unknown> },
      ];
      expect(pedido.updatePreferenceRequest).not.toHaveProperty('items');
    });

    it('si Mercado Pago lo rechaza lanza (quien llama lo trata como mejor esfuerzo)', async () => {
      actualizarPreferencia.mockRejectedValue(new Error('invalid'));

      await expect(adapter.expireCheckout('pref-9')).rejects.toThrow('invalid');
    });
  });
});
