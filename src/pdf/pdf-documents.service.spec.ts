import { BadRequestException, ConflictException } from '@nestjs/common';
import { PaymentStatus } from '../order/entities/order.entity';
import {
  ID_DE_PEDIDO,
  liquidacionDePrueba,
  MEMBRETE_DE_PRUEBA,
  pedidoDePrueba,
  rendicionDePrueba,
  sesionDeCajaDePrueba,
} from './datos-de-prueba';
import { PdfDocumentsService } from './pdf-documents.service';
import { textoDePdf } from './texto-de-pdf-de-prueba';
import type { CashDirection } from '../cash/domain/cash.enums';

const D = 'dist-1';

describe('PdfDocumentsService', () => {
  let pedidos: { getOne: jest.Mock; findOne: jest.Mock };
  let rendiciones: { detalle: jest.Mock };
  let liquidaciones: { findOne: jest.Mock };
  let sesiones: { findOne: jest.Mock; movimientosDe: jest.Mock };
  let movimientos: { conNombres: jest.Mock };
  let cajas: { findOne: jest.Mock };
  let reportes: Record<
    | 'getSalesByPaymentMethod'
    | 'getSalesByProduct'
    | 'getSalesByDriver'
    | 'getSalesEvolution'
    | 'getCollections',
    jest.Mock
  >;
  let membretes: { membreteDe: jest.Mock };
  let servicio: PdfDocumentsService;

  beforeEach(() => {
    pedidos = {
      getOne: jest.fn().mockResolvedValue(pedidoDePrueba()),
      findOne: jest.fn().mockResolvedValue({
        deliveryCode: '654321',
        paymentSurchargeAmount: 0,
        paymentSurchargePercentage: null,
      }),
    };
    rendiciones = { detalle: jest.fn().mockResolvedValue(rendicionDePrueba()) };
    liquidaciones = { findOne: jest.fn() };
    sesiones = { findOne: jest.fn(), movimientosDe: jest.fn() };
    movimientos = { conNombres: jest.fn() };
    cajas = { findOne: jest.fn() };
    const cifra = { totalOrders: 0, totalAmount: 0 };
    reportes = {
      getSalesByPaymentMethod: jest
        .fn()
        .mockResolvedValue([
          { method: 'cash', totalOrders: 4, totalSales: 40000 },
        ]),
      getSalesByProduct: jest.fn().mockResolvedValue([]),
      getSalesByDriver: jest.fn().mockResolvedValue([]),
      getSalesEvolution: jest.fn().mockResolvedValue([]),
      getCollections: jest.fn().mockResolvedValue({
        pendingCash: cifra,
        unpaid: cifra,
        writtenOff: cifra,
        pendingTransfer: cifra,
        notReceivedTransfer: cifra,
        pendingRefund: cifra,
      }),
    };
    membretes = { membreteDe: jest.fn().mockResolvedValue(MEMBRETE_DE_PRUEBA) };
    servicio = new PdfDocumentsService(
      pedidos as never,
      rendiciones as never,
      liquidaciones as never,
      sesiones as never,
      movimientos as never,
      cajas as never,
      reportes as never,
      membretes as never,
    );
  });

  describe('remito', () => {
    it('para el personal incluye el código de entrega y el membrete de la distribuidora del pedido', async () => {
      const doc = await servicio.remito(ID_DE_PEDIDO, { distributorId: D });

      expect(pedidos.getOne).toHaveBeenCalledWith(ID_DE_PEDIDO, D, undefined);
      expect(membretes.membreteDe).toHaveBeenCalledWith('dist-1');
      expect(doc.nombre).toBe('remito-0A1B2C3D.pdf');
      expect(doc.contenido.subarray(0, 5).toString()).toBe('%PDF-');
      expect(textoDePdf(doc.contenido)).toContain('654321');
    });

    it('para el cliente acota por dueño y no imprime el código de entrega', async () => {
      const doc = await servicio.remito(ID_DE_PEDIDO, {
        distributorId: null,
        customerUserId: 'u-cliente',
      });

      expect(pedidos.getOne).toHaveBeenCalledWith(
        ID_DE_PEDIDO,
        null,
        'u-cliente',
      );
      const texto = textoDePdf(doc.contenido);
      expect(texto).not.toContain('654321');
      expect(texto).not.toContain('CÓDIGO DE ENTREGA');
    });

    it('si el pedido es ajeno (404 del servicio) no arma nada', async () => {
      pedidos.getOne.mockRejectedValue(new Error('Order not found'));
      await expect(
        servicio.remito(ID_DE_PEDIDO, { distributorId: D }),
      ).rejects.toThrow('Order not found');
      expect(membretes.membreteDe).not.toHaveBeenCalled();
    });
  });

  describe('recibo', () => {
    it('emite el recibo de un pedido pagado', async () => {
      const doc = await servicio.recibo(ID_DE_PEDIDO, { distributorId: D });
      expect(doc.nombre).toBe('recibo-0A1B2C3D.pdf');
      expect(textoDePdf(doc.contenido)).toContain('RECIBO DE PAGO');
    });

    it.each([
      PaymentStatus.PENDING,
      PaymentStatus.FAILED,
      PaymentStatus.UNPAID,
      PaymentStatus.WRITTEN_OFF,
    ])('409 si el pago está %s', async (estado) => {
      pedidos.getOne.mockResolvedValue(
        pedidoDePrueba({ paymentStatus: estado }),
      );
      await expect(
        servicio.recibo(ID_DE_PEDIDO, { distributorId: D }),
      ).rejects.toThrow(ConflictException);
      expect(membretes.membreteDe).not.toHaveBeenCalled();
    });

    it('409 si el pedido está cancelado aunque el pago figure cobrado (a reintegrar)', async () => {
      pedidos.getOne.mockResolvedValue(
        pedidoDePrueba({
          paymentStatus: PaymentStatus.PAID,
          status: 'cancelled',
        }),
      );
      await expect(
        servicio.recibo(ID_DE_PEDIDO, { distributorId: D }),
      ).rejects.toThrow('El pedido está cancelado');
      expect(membretes.membreteDe).not.toHaveBeenCalled();
    });
  });

  describe('rendición', () => {
    it('lee con el acotado del chofer y usa la distribuidora del contexto', async () => {
      const doc = await servicio.rendicion('s-1', D, 'u-chofer');

      expect(rendiciones.detalle).toHaveBeenCalledWith('s-1', D, 'u-chofer');
      expect(membretes.membreteDe).toHaveBeenCalledWith(D);
      expect(doc.nombre).toBe('rendicion-12-2026-10-27.pdf');
      expect(textoDePdf(doc.contenido)).toContain('RENDICIÓN DE CHOFER');
    });
  });

  describe('liquidación', () => {
    it('arma el PDF con los asientos de la liquidación', async () => {
      const { entries, employeeName, ...liquidacion } = liquidacionDePrueba();
      liquidaciones.findOne.mockResolvedValue({
        item: { liquidacion, employeeName },
        asientos: entries.map((e) => ({ ...e, employeeId: 'emp-1' })),
      });
      const doc = await servicio.liquidacion('l-1', D);

      expect(liquidaciones.findOne).toHaveBeenCalledWith('l-1', D);
      expect(doc.nombre).toBe('liquidacion-3.pdf');
      const texto = textoDePdf(doc.contenido);
      expect(texto).toContain('NETO A PAGAR');
      expect(texto).toContain('Multa por exceso de velocidad');
    });
  });

  describe('cierre de caja', () => {
    it('suma entradas y salidas de los movimientos de la sesión', async () => {
      const s = sesionDeCajaDePrueba();
      const mov = (direction: CashDirection, amount: number) => ({
        direction,
        amount,
      });
      sesiones.findOne.mockResolvedValue({
        sesion: {
          sessionId: s.sessionId,
          cashBoxId: s.cashBoxId,
          status: 'open',
          openedAt: s.openedAt,
          openedByUserId: 'u-1',
          openingAmount: 5000,
          closedAt: null,
          closedByUserId: null,
          expectedAmount: null,
          countedAmount: null,
          difference: null,
          notes: null,
        },
        cashBoxName: 'Caja central',
      });
      sesiones.movimientosDe.mockResolvedValue([
        mov('in' as CashDirection, 100.1),
        mov('in' as CashDirection, 200.2),
        mov('out' as CashDirection, 50),
      ]);
      movimientos.conNombres.mockResolvedValue([]);
      cajas.findOne.mockResolvedValue({ caja: { balance: 5250.3 } });

      const doc = await servicio.cierreDeCaja(s.sessionId, D);

      expect(sesiones.findOne).toHaveBeenCalledWith(s.sessionId, D);
      expect(cajas.findOne).toHaveBeenCalledWith(s.cashBoxId, D);
      const texto = textoDePdf(doc.contenido);
      expect(texto).toContain('ARQUEO DE CAJA');
      expect(texto).toContain('$ 300,30'); // 100,10 + 200,20 sin error de coma flotante
      expect(texto).toContain('$ 5.250,30');
      expect(doc.nombre).toBe('caja-SES1.pdf');
    });
  });

  describe('reporte de ventas', () => {
    it('sin fechas toma hoy y consulta con la distribuidora', async () => {
      const doc = await servicio.reporteDeVentas(D);

      for (const consulta of Object.values(reportes)) {
        expect(consulta).toHaveBeenCalledTimes(1);
        expect(consulta.mock.calls[0]).toContain(D);
      }
      expect(reportes.getSalesEvolution.mock.calls[0] as unknown[]).toContain(
        'day',
      );
      expect(textoDePdf(doc.contenido)).toContain('$ 40.000,00');
    });

    it('el período es [inicio de desde, inicio del día siguiente a hasta) en hora argentina', async () => {
      await servicio.reporteDeVentas(D, '2026-10-01', '2026-10-31');

      const [desde, hasta] = reportes.getSalesByPaymentMethod.mock.calls[0] as [
        Date,
        Date,
      ];
      expect(desde.toISOString()).toBe('2026-10-01T03:00:00.000Z');
      expect(hasta.toISOString()).toBe('2026-11-01T03:00:00.000Z');
    });

    it('con una sola fecha el período es ese día', async () => {
      const doc = await servicio.reporteDeVentas(D, undefined, '2026-10-27');
      const [desde, hasta] = reportes.getSalesByDriver.mock.calls[0] as [
        Date,
        Date,
      ];
      expect(hasta.getTime() - desde.getTime()).toBe(24 * 3600 * 1000);
      expect(doc.nombre).toBe('ventas-27-10-2026_27-10-2026.pdf');
    });

    it('400 si desde es posterior a hasta, sin consultar nada', async () => {
      await expect(
        servicio.reporteDeVentas(D, '2026-10-31', '2026-10-01'),
      ).rejects.toThrow(BadRequestException);
      expect(reportes.getSalesByPaymentMethod).not.toHaveBeenCalled();
    });

    it('400 con una fecha que no existe', async () => {
      await expect(
        servicio.reporteDeVentas(D, '2026-02-30', '2026-03-01'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
