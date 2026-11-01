import { imagenesDePrueba } from '../../s3/imagenes-de-prueba';
import {
  ID_DE_PEDIDO,
  liquidacionDePrueba,
  MEMBRETE_DE_PRUEBA,
  pedidoDePrueba,
  rendicionDePrueba,
  sesionDeCajaDePrueba,
} from '../datos-de-prueba';
import { textoDePdf } from '../texto-de-pdf-de-prueba';
import { renderCierreDeCaja } from './cierre-de-caja.document';
import { renderLiquidacion } from './liquidacion.document';
import { renderRecibo } from './recibo.document';
import { renderRemito } from './remito.document';
import { renderRendicion } from './rendicion.document';
import { renderReporteDeVentas } from './ventas.document';
import {
  PaymentMethod,
  PaymentStatus,
} from '../../order/entities/order.entity';
import { CobrosDeEfectivoDto } from '../../reports/dto/report-response.dto';

const esPdf = (b: Buffer) => b.subarray(0, 5).toString() === '%PDF-';
const SIN_EXTRA = {
  deliveryCode: null,
  paymentSurchargeAmount: 0,
  paymentSurchargePercentage: null,
};

describe('documentos PDF', () => {
  it('textos con emojis, otros alfabetos y notas enormes no rompen el PDF', async () => {
    const pedido = pedidoDePrueba();
    pedido.address = {
      ...pedido.address!,
      formattedAddress: 'Calle Łódź 🔥 1200, Posadas 北京',
      additionalInstructions: `Tocar timbre. ${'Muy largo. '.repeat(300)}`,
    };
    const pdf = await renderRemito(pedido, SIN_EXTRA, MEMBRETE_DE_PRUEBA);

    expect(esPdf(pdf)).toBe(true);
    const texto = textoDePdf(pdf);
    expect(texto).toContain('Calle Lódz ? 1200, Posadas ??');
    // Las indicaciones se cortan a 300 caracteres: no entran las 300 repeticiones.
    expect((texto.match(/Muy largo/g) ?? []).length).toBeLessThan(30);
  });

  describe('remito', () => {
    it('es un PDF con el membrete, el cliente, los ítems, los recargos y el total', async () => {
      const pdf = await renderRemito(
        pedidoDePrueba(),
        {
          deliveryCode: '483920',
          paymentSurchargeAmount: 500,
          paymentSurchargePercentage: 7.5,
        },
        MEMBRETE_DE_PRUEBA,
      );

      expect(esPdf(pdf)).toBe(true);
      const texto = textoDePdf(pdf);
      expect(texto).toContain('Gas del Sur');
      expect(texto).toContain('CUIT 30-71234567-8');
      expect(texto).toContain('REMITO');
      expect(texto).toContain('Ana Gómez');
      expect(texto).toContain('Av. Mitre 1200, Posadas');
      expect(texto).toContain('Juan Pérez');
      expect(texto).toContain('AB123CD');
      expect(texto).toContain('Garrafa 10kg');
      expect(texto).toContain('$ 29.800,00');
      expect(texto).toContain('Recargo zona Garupá');
      expect(texto).toContain('Recargo por medio de pago (7,5 %)');
      expect(texto).toContain('Recargo envío express');
      expect(texto).toContain('Recargo por medio de pago');
      expect(texto).toContain('$ 33.300,00');
      expect(texto).toContain('Pagado');
      expect(texto).toContain('Efectivo');
      expect(texto).toContain('483920');
      expect(texto).toContain('Página 1 de 1');
    });

    it('sin código de entrega no imprime la línea del código', async () => {
      const texto = textoDePdf(
        await renderRemito(pedidoDePrueba(), SIN_EXTRA, MEMBRETE_DE_PRUEBA),
      );
      expect(texto).not.toContain('CÓDIGO DE ENTREGA');
    });

    it('un pedido sin chofer, sin vehículo y sin dirección sale igual', async () => {
      const pdf = await renderRemito(
        pedidoDePrueba({
          deliveryName: null,
          vehicle: null,
          address: null,
          customer: null,
          zoneSurcharge: null,
          expressSurchargeAmount: 0,
          paymentStatus: PaymentStatus.PENDING,
        }),
        SIN_EXTRA,
        MEMBRETE_DE_PRUEBA,
      );
      const texto = textoDePdf(pdf);
      expect(texto).toContain('Sin asignar');
      expect(texto).toContain('Pendiente');
      expect(texto).not.toContain('Recargo');
    });

    it('con muchos ítems sigue en otra página con la cabecera de la tabla', async () => {
      const base = pedidoDePrueba();
      const items = Array.from({ length: 60 }, () => base.items[0]);
      const pdf = await renderRemito(
        pedidoDePrueba({ items }),
        SIN_EXTRA,
        MEMBRETE_DE_PRUEBA,
      );
      const texto = textoDePdf(pdf);
      expect(texto).toMatch(/Página 1 de [2-9]/);
      expect(texto).toMatch(/Página 2 de [2-9]/);
      expect(texto.match(/Precio unit\./g)?.length).toBeGreaterThanOrEqual(2);
    });

    it('incrusta el logo (PNG) sin romper el documento', async () => {
      const logo = await imagenesDePrueba.png();
      const sin = await renderRemito(
        pedidoDePrueba(),
        SIN_EXTRA,
        MEMBRETE_DE_PRUEBA,
      );
      const con = await renderRemito(pedidoDePrueba(), SIN_EXTRA, {
        ...MEMBRETE_DE_PRUEBA,
        logo,
      });
      expect(esPdf(con)).toBe(true);
      expect(con.length).toBeGreaterThan(sin.length);
    });

    it('un logo corrupto se ignora y el documento sale igual', async () => {
      const pdf = await renderRemito(pedidoDePrueba(), SIN_EXTRA, {
        ...MEMBRETE_DE_PRUEBA,
        logo: Buffer.from('no es una imagen'),
      });
      expect(esPdf(pdf)).toBe(true);
      expect(textoDePdf(pdf)).toContain('Gas del Sur');
    });
  });

  describe('recibo', () => {
    it('dice a quién se le cobró, el medio y el total pagado', async () => {
      const texto = textoDePdf(
        await renderRecibo(
          pedidoDePrueba({ paymentMethodDetail: PaymentMethod.TRANSFER }),
          MEMBRETE_DE_PRUEBA,
        ),
      );
      expect(texto).toContain('RECIBO DE PAGO');
      expect(texto).toContain('Ana Gómez');
      expect(texto).toContain('Transferencia');
      expect(texto).toContain('TOTAL PAGADO');
      expect(texto).toContain('$ 33.300,00');
      expect(texto).toContain(
        ID_DE_PEDIDO.replace(/-/g, '').slice(0, 8).toUpperCase(),
      );
    });

    it('aclara que los precios incluyen IVA y que no es una factura', async () => {
      const texto = textoDePdf(
        await renderRecibo(pedidoDePrueba(), MEMBRETE_DE_PRUEBA),
      );
      expect(texto).toContain('Precios finales con IVA incluido.');
      expect(texto).toContain('Este recibo no es una factura');
    });
  });

  describe('rendición del chofer', () => {
    it('lleva pedidos, cobros, gastos, esperado, declarado y la diferencia resuelta', async () => {
      const pdf = await renderRendicion(
        rendicionDePrueba(),
        MEMBRETE_DE_PRUEBA,
      );
      expect(esPdf(pdf)).toBe(true);
      const texto = textoDePdf(pdf);
      expect(texto).toContain('RENDICIÓN DE CHOFER');
      expect(texto).toContain('N° 0012');
      expect(texto).toContain('27/10/2026');
      expect(texto).toContain('Juan Pérez');
      expect(texto).toContain('Aprobada');
      expect(texto).toContain('Panadería La Espiga S.R.L.');
      expect(texto).toContain('Combustible');
      expect(texto).toContain('$ 54.000,00');
      expect(texto).toContain('$ 51.000,00');
      expect(texto).toContain('-$ 1.500,00');
      expect(texto).toContain('Faltante: A cargo del chofer.');
      expect(texto).toContain('Notas: Faltó un vuelto');
    });

    it('una rendición abierta sin declarar muestra guiones y no inventa diferencia', async () => {
      const abierta = Object.assign(rendicionDePrueba(), {
        declaredCash: null,
        difference: null,
        differenceResolution: null,
        orders: [],
        collections: [],
        expenses: [],
        notes: null,
      });
      const texto = textoDePdf(
        await renderRendicion(abierta, MEMBRETE_DE_PRUEBA),
      );
      expect(texto).toContain('Sin pedidos en efectivo.');
      expect(texto).toContain('Sin gastos.');
      expect(texto).not.toContain('Faltante');
      expect(texto).not.toContain('Sobrante');
    });
  });

  describe('liquidación', () => {
    it('lleva los asientos y el neto a pagar', async () => {
      const texto = textoDePdf(
        await renderLiquidacion(liquidacionDePrueba(), MEMBRETE_DE_PRUEBA),
      );
      expect(texto).toContain('LIQUIDACIÓN');
      expect(texto).toContain('N° 0003');
      expect(texto).toContain('01/10/2026 al 31/10/2026');
      expect(texto).toContain('Comisión por entrega');
      expect(texto).toContain('Multa de tránsito');
      expect(texto).toContain('-$ 750,00');
      expect(texto).toContain('NETO A PAGAR');
      expect(texto).toContain('$ 8.250,00');
      expect(texto).toContain('Pagada');
    });
  });

  describe('cierre de caja', () => {
    it('lleva movimientos, esperado, contado y diferencia', async () => {
      const texto = textoDePdf(
        await renderCierreDeCaja(sesionDeCajaDePrueba(), MEMBRETE_DE_PRUEBA),
      );
      expect(texto).toContain('CIERRE DE CAJA');
      expect(texto).toContain('Caja central');
      expect(texto).toContain('Rendición de chofer');
      expect(texto).toContain('Librería');
      expect(texto).toContain('$ 18.250,00');
      expect(texto).toContain('Contado');
      expect(texto).toContain('$ 18.000,00');
      expect(texto).toContain('DIFERENCIA');
      expect(texto).toContain('-$ 250,00');
    });

    it('una sesión abierta sale como arqueo con el saldo actual', async () => {
      const abierta = Object.assign(sesionDeCajaDePrueba(), {
        status: 'open' as never,
        closedAt: null,
        expectedAmount: null,
        countedAmount: null,
        difference: null,
        notes: null,
      });
      const texto = textoDePdf(
        await renderCierreDeCaja(abierta, MEMBRETE_DE_PRUEBA),
      );
      expect(texto).toContain('ARQUEO DE CAJA');
      expect(texto).toContain('SALDO ACTUAL');
      expect(texto).not.toContain('DIFERENCIA');
      // esperado = apertura + entradas - salidas
      expect(texto).toContain('$ 18.250,00');
    });
  });

  describe('reporte de ventas', () => {
    const cifra = (totalOrders: number, totalAmount: number) => ({
      totalOrders,
      totalAmount,
    });
    const cobros: CobrosDeEfectivoDto = {
      pendingCash: cifra(2, 20000),
      unpaid: cifra(0, 0),
      writtenOff: cifra(0, 0),
      pendingTransfer: cifra(1, 9000),
      notReceivedTransfer: cifra(0, 0),
      pendingRefund: cifra(0, 0),
    };

    it('suma los medios de pago y detalla producto, chofer y evolución', async () => {
      const pdf = await renderReporteDeVentas(
        {
          desde: '2026-10-01',
          hasta: '2026-10-31',
          porMedioDePago: [
            { method: 'cash', totalOrders: 10, totalSales: 100000 },
            { method: 'mercadopago', totalOrders: 5, totalSales: 50000 },
          ],
          porProducto: [
            {
              productType: '10kg',
              description: 'Envase propio',
              totalQuantity: 30,
              totalSales: 150000,
            },
          ],
          porChofer: [
            {
              driverId: 'd1',
              driverName: 'Juan Pérez',
              totalOrders: 15,
              totalSales: 150000,
            },
          ],
          evolucion: [
            {
              period: new Date('2026-10-05T03:00:00Z'),
              totalOrders: 15,
              totalSales: 150000,
            },
          ],
          cobros,
        },
        MEMBRETE_DE_PRUEBA,
      );
      expect(esPdf(pdf)).toBe(true);
      const texto = textoDePdf(pdf);
      expect(texto).toContain('REPORTE DE VENTAS');
      expect(texto).toContain('01/10/2026 al 31/10/2026');
      expect(texto).toContain('VENTAS');
      expect(texto).toContain('$ 150.000,00');
      expect(texto).toContain('Mercado Pago');
      expect(texto).toContain('10kg · Envase propio');
      expect(texto).toContain('Juan Pérez');
      expect(texto).toContain('05/10/2026');
      expect(texto).toContain('Efectivo sin confirmar');
      expect(texto).toContain('$ 9.000,00');
    });

    it('un período sin ventas lo dice y un solo día no repite la fecha', async () => {
      const texto = textoDePdf(
        await renderReporteDeVentas(
          {
            desde: '2026-10-27',
            hasta: '2026-10-27',
            porMedioDePago: [],
            porProducto: [],
            porChofer: [],
            evolucion: [],
            cobros,
          },
          MEMBRETE_DE_PRUEBA,
        ),
      );
      expect(texto).toContain('Sin ventas en el período.');
      expect(texto).not.toContain('27/10/2026 al');
      expect(texto).toContain('$ 0,00');
    });
  });
});
