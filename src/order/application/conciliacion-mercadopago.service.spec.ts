import { Order, PaymentStatus } from '../entities/order.entity';
import { OrigenDelEstadoDelPago } from '../../payments/domain/payment.enums';
import { ConciliacionMercadoPagoService } from './conciliacion-mercadopago.service';

describe('ConciliacionMercadoPagoService', () => {
  let service: ConciliacionMercadoPagoService;
  let orderRepository: { find: jest.Mock; findOne: jest.Mock };
  let payments: { consultarPagosDelPedido: jest.Mock };
  let confirmPayment: { execute: jest.Mock };
  let refunds: {
    tieneDevolucionFallida: jest.Mock;
    tieneDevolucionFallidaDelPago: jest.Mock;
  };
  let events: { emit: jest.Mock };
  let config: { get: jest.Mock };
  const pedido = {
    orderId: 'ord-1',
    distributorId: 'dist-1',
    createdAt: new Date(),
  } as Order;
  const confirmado = {
    orderId: 'ord-1',
    gatewayPaymentId: '11',
    paymentStatus: PaymentStatus.PAID,
  } as Order;

  beforeEach(() => {
    orderRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(confirmado),
    };
    payments = { consultarPagosDelPedido: jest.fn() };
    confirmPayment = { execute: jest.fn().mockResolvedValue(undefined) };
    refunds = {
      tieneDevolucionFallida: jest.fn().mockResolvedValue(false),
      tieneDevolucionFallidaDelPago: jest.fn().mockResolvedValue(false),
    };
    events = { emit: jest.fn() };
    config = { get: jest.fn((_clave: string, defecto: number) => defecto) };
    service = new ConciliacionMercadoPagoService(
      orderRepository as never,
      payments as never,
      confirmPayment as never,
      refunds as never,
      events as never,
      config as never,
    );
  });

  const avisos = () =>
    events.emit.mock.calls.map(
      ([, aviso]: [string, { kind: string; dedupeKey: string }]) => aviso,
    );

  it('un pago aprobado sin aviso se aplica con el mismo caso de uso del webhook', async () => {
    payments.consultarPagosDelPedido.mockResolvedValue([
      { gatewayPaymentId: '10', status: 'rejected', credentialId: null },
      { gatewayPaymentId: '11', status: 'approved', credentialId: 'cred-1' },
    ]);

    await expect(service.resolverCobro(pedido)).resolves.toBe('aplicado');

    expect(confirmPayment.execute).toHaveBeenCalledWith({
      type: 'payment',
      dataId: '11',
      origin: OrigenDelEstadoDelPago.CONCILIACION,
      credentialId: 'cred-1',
    });
  });

  it('con la cuenta del sistema no manda credentialId', async () => {
    payments.consultarPagosDelPedido.mockResolvedValue([
      { gatewayPaymentId: '11', status: 'approved', credentialId: null },
    ]);

    await service.resolverCobro(pedido);

    expect(confirmPayment.execute).toHaveBeenCalledWith(
      expect.objectContaining({ dataId: '11', credentialId: undefined }),
    );
  });

  it('con dos pagos aprobados aplica los dos, el más viejo primero (el segundo se devuelve como duplicado)', async () => {
    payments.consultarPagosDelPedido.mockResolvedValue([
      { gatewayPaymentId: '120', status: 'approved', credentialId: null },
      { gatewayPaymentId: '99', status: 'approved', credentialId: null },
    ]);

    await expect(service.resolverCobro(pedido)).resolves.toBe('aplicado');

    expect(
      confirmPayment.execute.mock.calls.map(
        ([entrada]: [{ dataId: string }]) => entrada.dataId,
      ),
    ).toEqual(['99', '120']);
  });

  it('un pago con reclamo abierto ya estaba cobrado: se aplica al pedido, no se espera', async () => {
    payments.consultarPagosDelPedido.mockResolvedValue([
      { gatewayPaymentId: '11', status: 'in_mediation', credentialId: null },
    ]);

    await expect(service.resolverCobro(pedido)).resolves.toBe('aplicado');
    expect(confirmPayment.execute).toHaveBeenCalledWith(
      expect.objectContaining({ dataId: '11' }),
    );
  });

  it.each(['pending', 'in_process', 'authorized'])(
    'un pago %s todavía puede cobrarse: espera',
    async (status) => {
      payments.consultarPagosDelPedido.mockResolvedValue([
        { gatewayPaymentId: '12', status, credentialId: null },
      ]);

      await expect(service.resolverCobro(pedido)).resolves.toBe('esperar');
      expect(confirmPayment.execute).not.toHaveBeenCalled();
    },
  );

  it('sin pagos, o sólo rechazados, cancelados, devueltos o con contracargo: se puede cancelar', async () => {
    payments.consultarPagosDelPedido.mockResolvedValue([]);
    await expect(service.resolverCobro(pedido)).resolves.toBe('libre');

    payments.consultarPagosDelPedido.mockResolvedValue([
      { gatewayPaymentId: '13', status: 'rejected', credentialId: null },
      { gatewayPaymentId: '14', status: 'cancelled', credentialId: null },
    ]);
    await expect(service.resolverCobro(pedido)).resolves.toBe('libre');
  });

  it('si Mercado Pago no responde no se da por libre: espera', async () => {
    payments.consultarPagosDelPedido.mockRejectedValue(new Error('timeout'));

    await expect(service.resolverCobro(pedido)).resolves.toBe('esperar');
    expect(confirmPayment.execute).not.toHaveBeenCalled();
  });

  it('si no se puede aplicar el pago aprobado, espera (no cancela)', async () => {
    payments.consultarPagosDelPedido.mockResolvedValue([
      { gatewayPaymentId: '11', status: 'approved', credentialId: null },
    ]);
    confirmPayment.execute.mockRejectedValue(new Error('base caída'));

    await expect(service.resolverCobro(pedido)).resolves.toBe('esperar');
  });

  describe('M1: el pago cobrado que el pedido no tomó', () => {
    beforeEach(() => {
      payments.consultarPagosDelPedido.mockResolvedValue([
        { gatewayPaymentId: '11', status: 'approved', credentialId: null },
      ]);
      // El caso de uso no confirmó nada (importe o cuenta distintos).
      orderRepository.findOne.mockResolvedValue({
        orderId: 'ord-1',
        gatewayPaymentId: null,
        paymentStatus: PaymentStatus.PENDING,
      });
    });

    it('no dice «aplicado»: el veredicto es «revisar» y no se cancela', async () => {
      await expect(service.resolverCobro(pedido)).resolves.toBe('revisar');
    });

    it('avisa al administrador, una vez por pago (dedupe)', async () => {
      await service.resolverCobro(pedido);
      await service.resolverCobro(pedido);

      expect(avisos()).toHaveLength(2);
      expect(avisos()[0]).toMatchObject({
        kind: 'payment_needs_review',
        dedupeKey: 'mp-revisar:ord-1:11',
      });
      expect(avisos()[1].dedupeKey).toBe(avisos()[0].dedupeKey);
    });
  });

  describe('M3: la consulta a Mercado Pago falla y no se arregla sola', () => {
    const vieja = {
      ...pedido,
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    } as Order;

    it('un pedido reciente sólo espera (puede ser un corte pasajero)', async () => {
      payments.consultarPagosDelPedido.mockRejectedValue({ status: 401 });

      await expect(service.resolverCobro(pedido)).resolves.toBe('esperar');
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('con la credencial rechazada (401) y horas de espera, avisa al administrador', async () => {
      payments.consultarPagosDelPedido.mockRejectedValue({ status: 401 });

      await expect(service.resolverCobro(vieja)).resolves.toBe('esperar');

      expect(avisos()[0]).toMatchObject({
        kind: 'payment_lookup_failed',
        dedupeKey: 'mp-consulta:ord-1',
      });
    });

    it('lo mismo con un 403', async () => {
      payments.consultarPagosDelPedido.mockRejectedValue({ status: 403 });
      await service.resolverCobro(vieja);
      expect(avisos()).toHaveLength(1);
    });

    it('con cualquier otra falla persistente también avisa', async () => {
      payments.consultarPagosDelPedido.mockRejectedValue(new Error('timeout'));
      await service.resolverCobro(vieja);
      expect(avisos()[0].kind).toBe('payment_lookup_failed');
    });
  });

  describe('barrido de pedidos pendientes', () => {
    it('revisa los pendientes con más de 3 minutos y cuenta los aplicados', async () => {
      orderRepository.find.mockResolvedValue([
        { orderId: 'a' },
        { orderId: 'b' },
      ]);
      payments.consultarPagosDelPedido
        .mockResolvedValueOnce([
          { gatewayPaymentId: '1', status: 'approved', credentialId: null },
        ])
        .mockResolvedValueOnce([]);

      await expect(service.conciliarPendientes()).resolves.toBe(1);

      expect(orderRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            // También las reservas con la seña por Mercado Pago (M-5).
            status: expect.objectContaining({
              _value: ['pending', 'reserved'],
            }) as object,
            paymentMethod: 'mercadopago',
          }) as object,
        }),
      );
      expect(confirmPayment.execute).toHaveBeenCalledTimes(1);
    });

    it('si hay más pedidos que el lote, la pasada siguiente empieza por los que hace más que no mira', async () => {
      const LOTE = ConciliacionMercadoPagoService.LOTE;
      const todos = Array.from({ length: LOTE + 10 }, (_, i) => ({
        orderId: `p-${i}`,
        createdAt: new Date(2026, 0, 1, 0, i),
      }));
      orderRepository.find.mockResolvedValue(todos);
      payments.consultarPagosDelPedido.mockResolvedValue([
        { gatewayPaymentId: '1', status: 'pending', credentialId: null },
      ]);

      await service.conciliarPendientes();
      const primera = payments.consultarPagosDelPedido.mock.calls.map(
        ([id]: [string]) => id,
      );
      payments.consultarPagosDelPedido.mockClear();
      await service.conciliarPendientes();
      const segunda = payments.consultarPagosDelPedido.mock.calls.map(
        ([id]: [string]) => id,
      );

      expect(primera).toHaveLength(LOTE);
      expect(primera).not.toContain(`p-${LOTE + 5}`);
      // Los 10 que la primera pasada no llegó a mirar van primero en la segunda.
      expect(segunda.slice(0, 10)).toEqual(
        Array.from({ length: 10 }, (_, i) => `p-${LOTE + i}`),
      );
    });
  });

  describe('A1: barrido de pedidos cancelados', () => {
    beforeEach(() => {
      orderRepository.find.mockResolvedValue([{ orderId: 'c-1' }]);
    });

    it('un pago aprobado que entró después de la cancelación se aplica (el caso de uso lo devuelve)', async () => {
      payments.consultarPagosDelPedido.mockResolvedValue([
        { gatewayPaymentId: '77', status: 'approved', credentialId: 'cred-1' },
      ]);

      await expect(service.conciliarCancelados()).resolves.toBe(1);

      expect(confirmPayment.execute).toHaveBeenCalledWith({
        type: 'payment',
        dataId: '77',
        origin: OrigenDelEstadoDelPago.CONCILIACION,
        credentialId: 'cred-1',
      });
      expect(orderRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'cancelled',
            paymentMethod: 'mercadopago',
          }) as object,
        }),
      );
    });

    it('un pago ya devuelto (o rechazado) en Mercado Pago no se vuelve a pedir', async () => {
      payments.consultarPagosDelPedido.mockResolvedValue([
        { gatewayPaymentId: '77', status: 'refunded', credentialId: null },
        { gatewayPaymentId: '78', status: 'rejected', credentialId: null },
      ]);

      await expect(service.conciliarCancelados()).resolves.toBe(0);
      expect(confirmPayment.execute).not.toHaveBeenCalled();
    });

    it('B-2: el pago cuya devolución rechazó la pasarela espera al administrador, pero un pago NUEVO del mismo pedido se atiende', async () => {
      payments.consultarPagosDelPedido.mockResolvedValue([
        { gatewayPaymentId: '77', status: 'approved', credentialId: null },
        { gatewayPaymentId: '88', status: 'approved', credentialId: null },
      ]);
      refunds.tieneDevolucionFallidaDelPago.mockImplementation((id: string) =>
        Promise.resolve(id === '77'),
      );

      await expect(service.conciliarCancelados()).resolves.toBe(1);

      expect(confirmPayment.execute).toHaveBeenCalledTimes(1);
      expect(confirmPayment.execute).toHaveBeenCalledWith(
        expect.objectContaining({ dataId: '88' }),
      );
    });

    it('B-3: un pago en reclamo sobre un pedido cancelado NO se cuenta ni se loguea como devolución pedida: se avisa al administrador', async () => {
      orderRepository.find.mockResolvedValue([
        { orderId: 'c-1', distributorId: 'dist-1' },
      ]);
      payments.consultarPagosDelPedido.mockResolvedValue([
        { gatewayPaymentId: '77', status: 'in_mediation', credentialId: null },
      ]);

      await expect(service.conciliarCancelados()).resolves.toBe(0);

      expect(confirmPayment.execute).not.toHaveBeenCalled();
      expect(avisos()[0]).toMatchObject({
        kind: 'payment_needs_review',
        dedupeKey: 'mp-revisar-cancelado:c-1:77',
      });
    });

    it('B-2: con más cancelados que una página, revisa también los de las páginas siguientes (hasta el lote)', async () => {
      const lote = ConciliacionMercadoPagoService.LOTE * 4;
      const pagina = (desde: number) =>
        Array.from({ length: lote }, (_, i) => ({ orderId: `c-${desde + i}` }));
      orderRepository.find
        .mockResolvedValueOnce(pagina(0))
        .mockResolvedValueOnce(pagina(lote));
      payments.consultarPagosDelPedido.mockResolvedValue([]);

      await service.conciliarCancelados();

      // El lote de una pasada es de 50: se corta ahí, pero se pidió paginar con `skip`.
      expect(payments.consultarPagosDelPedido).toHaveBeenCalledTimes(
        ConciliacionMercadoPagoService.LOTE,
      );
      expect(
        (orderRepository.find.mock.calls as unknown[][])[0][0],
      ).toMatchObject({
        take: lote,
        skip: 0,
      });
    });

    it('usa la ventana configurada en horas', async () => {
      config.get.mockReturnValue(6);
      payments.consultarPagosDelPedido.mockResolvedValue([]);

      await service.conciliarCancelados();

      const donde = (
        orderRepository.find.mock.calls[0] as [
          { where: { updatedAt: { _value: Date } } },
        ]
      )[0].where.updatedAt._value;
      const horas = (Date.now() - donde.getTime()) / 3_600_000;
      expect(horas).toBeGreaterThan(5.9);
      expect(horas).toBeLessThan(6.1);
    });

    it('si falla un pedido sigue con los demás', async () => {
      orderRepository.find.mockResolvedValue([
        { orderId: 'c-1' },
        { orderId: 'c-2' },
      ]);
      payments.consultarPagosDelPedido
        .mockRejectedValueOnce(new Error('MP caído'))
        .mockResolvedValueOnce([
          { gatewayPaymentId: '9', status: 'approved', credentialId: null },
        ]);

      await expect(service.conciliarCancelados()).resolves.toBe(1);
    });
  });
});
