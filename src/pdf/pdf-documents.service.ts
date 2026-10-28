import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { CashSessionService } from '../cash/application/cash-session.service';
import { CashMovementService } from '../cash/application/cash-movement.service';
import { CashBoxService } from '../cash/application/cash-box.service';
import { CashMapper } from '../cash/cash.mapper';
import { CashDirection } from '../cash/domain/cash.enums';
import { DriverLiquidationService } from '../commission/application/driver-liquidation.service';
import { CommissionMapper } from '../commission/presentation/commission.mapper';
import { aCentavos, sumar } from '../common/utils/dinero';
import {
  diaArgentino,
  rangoDeDiasArgentinos,
} from '../common/utils/dias-argentina';
import { DriverSettlementQueryService } from '../driver-settlement/application/driver-settlement-query.service';
import { PaymentStatus } from '../order/entities/order.entity';
import { OrderService } from '../order/order.service';
import { ReportsService } from '../reports/reports.service';
import { renderCierreDeCaja } from './documents/cierre-de-caja.document';
import { renderLiquidacion } from './documents/liquidacion.document';
import { renderRecibo } from './documents/recibo.document';
import { renderRemito } from './documents/remito.document';
import { renderRendicion } from './documents/rendicion.document';
import { renderReporteDeVentas } from './documents/ventas.document';
import { PdfBrandingService } from './pdf-branding.service';
import { codigoCorto, diaCalendario } from './pdf-formato';

export interface DocumentoPdf {
  contenido: Buffer;
  /** Nombre sugerido para guardar el archivo. */
  nombre: string;
}

/** Quién pide un pedido: el cliente sólo lee los suyos. */
export interface SolicitanteDelPedido {
  /** Distribuidora en contexto; el cliente puede no tener una elegida. */
  distributorId: string | null;
  /** Presente cuando pide un cliente: restringe a sus pedidos. */
  customerUserId?: string;
}

/**
 * Documentos PDF de la distribuidora. Cada método lee con la misma regla de
 * acceso y de aislamiento que el endpoint JSON del mismo recurso (un recurso
 * ajeno responde 404) y arma el PDF con el membrete de la distribuidora dueña.
 */
@Injectable()
export class PdfDocumentsService {
  constructor(
    private readonly pedidos: OrderService,
    private readonly rendiciones: DriverSettlementQueryService,
    private readonly liquidaciones: DriverLiquidationService,
    private readonly sesiones: CashSessionService,
    private readonly movimientos: CashMovementService,
    private readonly cajas: CashBoxService,
    private readonly reportes: ReportsService,
    private readonly membretes: PdfBrandingService,
  ) {}

  async remito(
    orderId: string,
    quien: SolicitanteDelPedido,
  ): Promise<DocumentoPdf> {
    const pedido = await this.pedidos.getOne(
      orderId,
      quien.distributorId,
      quien.customerUserId,
    );
    const entidad = await this.pedidos.findOne(orderId);
    const membrete = await this.membretes.membreteDe(pedido.distributorId);
    const contenido = await renderRemito(
      pedido,
      {
        // El código confirma la entrega: el cliente no lo recibe por escrito.
        deliveryCode: quien.customerUserId ? null : entidad.deliveryCode,
        paymentSurchargeAmount: entidad.paymentSurchargeAmount,
      },
      membrete,
    );
    return { contenido, nombre: `remito-${codigoCorto(orderId)}.pdf` };
  }

  async recibo(
    orderId: string,
    quien: SolicitanteDelPedido,
  ): Promise<DocumentoPdf> {
    const pedido = await this.pedidos.getOne(
      orderId,
      quien.distributorId,
      quien.customerUserId,
    );
    if (pedido.paymentStatus !== PaymentStatus.PAID) {
      throw new ConflictException(
        'El pedido todavía no está pagado: no hay recibo para emitir',
      );
    }
    if (pedido.status === 'cancelled') {
      // Un cancelado pagado está a reintegrar o ya reintegrado: no hay venta que respaldar.
      throw new ConflictException(
        'El pedido está cancelado: el pago se reintegra y no hay recibo para emitir',
      );
    }
    const membrete = await this.membretes.membreteDe(pedido.distributorId);
    return {
      contenido: await renderRecibo(pedido, membrete),
      nombre: `recibo-${codigoCorto(orderId)}.pdf`,
    };
  }

  async rendicion(
    id: string,
    distributorId: string,
    soloDelUsuario?: string,
  ): Promise<DocumentoPdf> {
    const detalle = await this.rendiciones.detalle(
      id,
      distributorId,
      soloDelUsuario,
    );
    const membrete = await this.membretes.membreteDe(distributorId);
    return {
      contenido: await renderRendicion(detalle, membrete),
      nombre: `rendicion-${detalle.number}-${detalle.businessDate}.pdf`,
    };
  }

  async liquidacion(id: string, distributorId: string): Promise<DocumentoPdf> {
    const { item, asientos } = await this.liquidaciones.findOne(
      id,
      distributorId,
    );
    const detalle = CommissionMapper.liquidacionConAsientos(item, asientos);
    const membrete = await this.membretes.membreteDe(distributorId);
    return {
      contenido: await renderLiquidacion(detalle, membrete),
      nombre: `liquidacion-${detalle.number}.pdf`,
    };
  }

  async cierreDeCaja(id: string, distributorId: string): Promise<DocumentoPdf> {
    const { sesion, cashBoxName } = await this.sesiones.findOne(
      id,
      distributorId,
    );
    const crudos = await this.sesiones.movimientosDe(id);
    const conNombres = await this.movimientos.conNombres(crudos);
    const { caja } = await this.cajas.findOne(sesion.cashBoxId, distributorId);
    const suma = (d: CashDirection) =>
      aCentavos(
        sumar(crudos.filter((m) => m.direction === d).map((m) => m.amount)),
      );
    const detalle = CashMapper.sesionConDetalle(sesion, cashBoxName, {
      currentBalance: caja.balance,
      totalIn: suma(CashDirection.IN),
      totalOut: suma(CashDirection.OUT),
      movements: conNombres.map((m) => CashMapper.movimiento(m.movimiento, m)),
    });
    const membrete = await this.membretes.membreteDe(distributorId);
    return {
      contenido: await renderCierreDeCaja(detalle, membrete),
      nombre: `caja-${codigoCorto(sesion.sessionId)}.pdf`,
    };
  }

  async reporteDeVentas(
    distributorId: string,
    desde?: string,
    hasta?: string,
  ): Promise<DocumentoPdf> {
    // Mismas reglas que los reportes del panel: sin fechas, hoy; con una sola,
    // ese día; `hasta` inclusivo, en hora argentina.
    const hoy = diaArgentino();
    const primero = desde ?? hasta ?? hoy;
    const ultimo = hasta ?? desde ?? hoy;
    if (primero > ultimo) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    const rango = rangoDeDiasArgentinos(primero, ultimo);
    if (!rango) {
      throw new BadRequestException('Fecha inválida (YYYY-MM-DD)');
    }
    const [porMedioDePago, porProducto, porChofer, evolucion, cobros] =
      await Promise.all([
        this.reportes.getSalesByPaymentMethod(
          rango.desde,
          rango.hasta,
          distributorId,
        ),
        this.reportes.getSalesByProduct(
          rango.desde,
          rango.hasta,
          distributorId,
        ),
        this.reportes.getSalesByDriver(rango.desde, rango.hasta, distributorId),
        this.reportes.getSalesEvolution(
          rango.desde,
          rango.hasta,
          'day',
          distributorId,
        ),
        this.reportes.getCollections(rango.desde, rango.hasta, distributorId),
      ]);
    const membrete = await this.membretes.membreteDe(distributorId);
    return {
      contenido: await renderReporteDeVentas(
        {
          desde: primero,
          hasta: ultimo,
          porMedioDePago,
          porProducto,
          porChofer,
          evolucion,
          cobros,
        },
        membrete,
      ),
      nombre: `ventas-${diaCalendario(primero).replace(/\//g, '-')}_${diaCalendario(ultimo).replace(/\//g, '-')}.pdf`,
    };
  }
}
