import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  assertSenaConMercadoPago,
  assertSenaNoSuperaTotal,
  saldoTrasLaSena,
  totalBajoLaSenaPagada,
} from '../domain/deposit-cap';
import Decimal from 'decimal.js';
import { RoleType } from '../../common/constants/role-type.enum';
import { DataSource } from 'typeorm';
import { TimeSlotService } from '../../time-slot/time-slot.service';
import { DistributorService } from '../../distributor/distributor.service';
import { InsufficientStockError } from '../../gascylinder/domain/errors/insufficient-stock.error';
import { CartService } from '../../cart/cart.service';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { UserAddressService } from '../../user-address/user-address.service';
import { CreateOrderUseCase } from './create-order.use-case';
import { QuoteOrderDto, QuoteResponseDto } from '../dto/quote-order.dto';
import {
  Order,
  OrderDeliveryMode,
  PaymentMethod,
} from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import type { ZonaParaRecargo } from '../../coverage-zone/coverage-zone-pricing.service';
import {
  MENSAJE_NO_PASAR_A_MERCADOPAGO,
  MENSAJE_SENA_PAGADA,
  agendaDeEdicion,
  mensajeDeNoEditable,
  motivoNoEditable,
  zonaGuardada,
} from '../domain/order-editable';
import { diaArgentino } from '../../common/utils/dias-argentina';

/**
 * Cotización de un pedido: el mismo cálculo que el alta (`CreateOrderUseCase`:
 * `valorizarRenglon`, `resolverZona` y `calcularTotales`), sin escribir nada ni
 * reservar stock. Así la cotización y el total del pedido creado con el mismo
 * cuerpo no pueden diferir: no hay una segunda copia de las reglas.
 */
@Injectable()
export class QuoteOrderUseCase {
  constructor(
    private readonly createOrder: CreateOrderUseCase,
    private readonly stock: GasCylinderService,
    private readonly addresses: UserAddressService,
    private readonly distributors: DistributorService,
    private readonly timeSlots: TimeSlotService,
    private readonly dataSource: DataSource,
    private readonly cart: CartService,
  ) {}

  private itemsDelCarrito(
    customerId: string | undefined,
    distributorId: string | null,
  ) {
    if (!customerId || !distributorId) {
      throw new BadRequestException(
        'Indicá la distribuidora (X-Distributor) para cotizar el carrito',
      );
    }
    return this.cart.itemsParaPedido(
      this.dataSource.manager,
      customerId,
      distributorId,
      false,
    );
  }

  /**
   * @param actor quien cotiza: un cliente cotiza para sí mismo; un admin, para
   *   el cliente que indique (`customerId`, necesario sólo con `addressId`).
   */
  async execute(
    dto: QuoteOrderDto,
    distributorId: string | null,
    actor: { userId: string; role: RoleType },
  ): Promise<QuoteResponseDto> {
    if (dto.fromCart && dto.items !== undefined) {
      throw new BadRequestException(
        'Con fromCart los ítems salen del carrito: no mandes items',
      );
    }
    if (dto.fromCart && dto.orderId) {
      throw new BadRequestException(
        'fromCart no se combina con orderId: la edición de un pedido no usa el carrito',
      );
    }
    if (!dto.fromCart && dto.items === undefined) {
      throw new BadRequestException('items es obligatorio (o usá fromCart)');
    }

    // Cotización de edición: el pedido manda (distribuidora, cliente, zona,
    // franja y fecha); se rechaza lo que el PATCH rechazaría.
    const edicion = dto.orderId
      ? await this.cargarParaEditar(dto.orderId, distributorId, actor, dto)
      : null;
    if (edicion) {
      distributorId = edicion.order.distributorId;
    } else if (!distributorId) {
      const porDefecto = await this.distributors.getDefault();
      distributorId = porDefecto?.distributorId ?? null;
    }
    if (!edicion && dto.isReservation && !dto.scheduledDate) {
      throw new BadRequestException(
        'Una reserva requiere scheduledDate (fecha de entrega agendada)',
      );
    }

    const customerId = edicion
      ? edicion.order.customerId
      : actor.role === RoleType.CUSTOMER
        ? actor.userId
        : dto.customerId;
    if (
      actor.role === RoleType.CUSTOMER &&
      dto.customerId &&
      dto.customerId !== actor.userId
    ) {
      throw new ForbiddenException(
        'No autorizado a cotizar pedidos para otro cliente',
      );
    }

    if (edicion) {
      await this.validarAgendaDeEdicion(edicion.order, dto, distributorId);
    } else {
      // Misma validación de la franja que el alta (sin tomar locks).
      if (dto.timeSlotId && !dto.scheduledDate) {
        await this.timeSlots.assertSlotUsableTx(
          this.dataSource.manager,
          dto.timeSlotId,
          distributorId,
        );
      }
      if (dto.timeSlotId && dto.scheduledDate) {
        await this.timeSlots.assertSlotAvailable(
          dto.timeSlotId,
          dto.scheduledDate,
          distributorId,
        );
      }
    }

    const esExpress = dto.deliveryMode === OrderDeliveryMode.EXPRESS;
    if (esExpress) {
      if (edicion) {
        throw new BadRequestException(
          'La modalidad express se elige al crear el pedido: no se cambia al editarlo',
        );
      }
      if (!dto.addressId) {
        throw new BadRequestException(
          'Indicá addressId para cotizar la modalidad express',
        );
      }
      this.createOrder.assertExpressCompatible(dto);
    }

    let zona: ZonaCotizada | null = null;
    let expressSurcharge = 0;
    if (
      edicion &&
      (!dto.addressId || dto.addressId === edicion.order.addressId)
    ) {
      zona = this.zonaDelPedido(edicion.order);
    } else if (dto.addressId) {
      if (!customerId) {
        throw new BadRequestException(
          'Indicá customerId para cotizar con la zona de una dirección',
        );
      }
      const address = await this.addresses.buscarDelUsuario(
        dto.addressId,
        customerId,
      );
      if (!address) {
        throw new NotFoundException('Dirección no encontrada');
      }
      zona = await this.createOrder.resolverZona(distributorId, address);
      if (esExpress) {
        expressSurcharge = await this.createOrder.recargoExpress(
          distributorId,
          address,
        );
      }
    }

    // Checkout del carrito: se cotizan los ítems del carrito del cliente, sin bloquearlo.
    const aCotizar = dto.fromCart
      ? await this.itemsDelCarrito(customerId, distributorId)
      : (dto.items ?? []);

    // Mismo orden que el alta: los renglones se valorizan de a uno.
    let subtotal = new Decimal(0);
    const items: QuoteResponseDto['items'] = [];
    for (const item of aCotizar) {
      const producto = await this.stock.leerParaCotizar(item.gasCylinderId);
      // Primero la distribuidora y después el stock, como el alta: con el id de
      // un producto ajeno no se distingue "sin stock" de "no pertenece".
      const renglon = this.createOrder.valorizarRenglon(
        producto,
        item,
        distributorId,
      );
      // Alta: la cantidad entera contra el vendible. Edición: sólo la
      // diferencia contra lo que el pedido ya tiene reservado, igual que
      // `reajustarReserva`.
      const yaReservado = edicion?.cantidades.get(item.gasCylinderId) ?? 0;
      const faltante = edicion ? item.quantity - yaReservado : item.quantity;
      if (faltante > 0 && producto.stock < faltante) {
        throw new InsufficientStockError(producto.type);
      }
      subtotal = subtotal.plus(renglon.subtotal);
      items.push({
        gasCylinderId: item.gasCylinderId,
        title: renglon.checkoutItem.title,
        quantity: item.quantity,
        unitPrice: renglon.checkoutItem.unitPrice,
        subtotal: renglon.subtotal.toNumber(),
        discountPercentage: renglon.discountPercentage,
      });
    }

    // Alta: el % vigente de la distribuidora. Edición: el del pedido si el medio
    // de pago no cambia (lo mismo que hará el PATCH).
    const paymentSurchargePercentage = edicion
      ? await this.createOrder.porcentajeDeRecargoDelPedido(
          edicion.order,
          dto.paymentMethod,
        )
      : await this.createOrder.porcentajeDeRecargo(
          distributorId,
          dto.paymentMethod,
        );
    const { totalAmount, zoneSurchargeAmount, paymentSurchargeAmount } =
      this.createOrder.calcularTotales(
        subtotal,
        zona,
        paymentSurchargePercentage,
        expressSurcharge,
      );
    // La base guarda los montos con 2 decimales: la cotización devuelve lo
    // mismo que quedará en el pedido.
    const total = totalAmount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const deposit = new Decimal(
      edicion
        ? edicion.order.depositAmount
        : dto.isReservation
          ? (dto.depositAmount ?? 0)
          : 0,
    );
    if (
      edicion?.order.depositPaid &&
      totalBajoLaSenaPagada(total, edicion.order.depositAmount)
    ) {
      throw new ConflictException(MENSAJE_SENA_PAGADA);
    }
    // Las reservas no se editan (`motivoNoEditable`): el tope sólo corre en el alta.
    if (!edicion && dto.isReservation) {
      assertSenaConMercadoPago(dto.paymentMethod, deposit);
      assertSenaNoSuperaTotal(deposit, total);
    }

    const res = new QuoteResponseDto();
    res.items = items;
    res.subtotal = subtotal.toNumber();
    res.zone = zona
      ? {
          coverageZoneId: zona.id,
          name: zona.name,
          type: zona.type,
          value: Number(zona.value),
          amount: zoneSurchargeAmount.toNumber(),
        }
      : null;
    res.zoneSurcharge = zoneSurchargeAmount.toNumber();
    res.paymentMethod = dto.paymentMethod;
    res.paymentSurcharge = paymentSurchargeAmount.toNumber();
    res.paymentSurchargePercentage = new Decimal(
      paymentSurchargePercentage,
    ).toNumber();
    res.deliveryMode = esExpress
      ? OrderDeliveryMode.EXPRESS
      : OrderDeliveryMode.STANDARD;
    res.expressSurcharge = expressSurcharge;
    res.deposit = deposit.toNumber();
    res.total = total.toNumber();
    res.balance = saldoTrasLaSena(total, deposit).toNumber();
    return res;
  }

  /**
   * El pedido a editar, si quien cotiza puede verlo (el suyo; o de la
   * distribuidora del staff) y es editable. Mismas reglas que el PATCH.
   */
  private async cargarParaEditar(
    orderId: string,
    distributorId: string | null,
    actor: { userId: string; role: RoleType },
    dto: QuoteOrderDto,
  ): Promise<{ order: Order; cantidades: Map<string, number> }> {
    const esCliente = actor.role === RoleType.CUSTOMER;
    const order = await this.dataSource.manager.findOne(Order, {
      where: { orderId },
    });
    if (
      !order ||
      (esCliente && order.customerId !== actor.userId) ||
      (!esCliente && distributorId && order.distributorId !== distributorId)
    ) {
      throw new NotFoundException('Pedido no encontrado');
    }
    const noEditable = motivoNoEditable(order);
    if (noEditable) {
      throw new ConflictException(
        mensajeDeNoEditable(order, noEditable, esCliente),
      );
    }
    if (dto.paymentMethod === PaymentMethod.MERCADOPAGO) {
      throw new BadRequestException(MENSAJE_NO_PASAR_A_MERCADOPAGO);
    }
    const renglones = await this.dataSource.manager.find(OrderItem, {
      where: { orderId },
    });
    const cantidades = new Map<string, number>();
    for (const r of renglones) {
      cantidades.set(
        r.gasCylinderId,
        (cantidades.get(r.gasCylinderId) ?? 0) + r.quantity,
      );
    }
    return { order, cantidades };
  }

  /**
   * Franja y fecha de una edición: sólo se validan si cambian (el pedido ya
   * ocupa su lugar actual, aunque la franja esté llena o ya haya terminado).
   * Misma regla que `UpdateOrderUseCase`.
   */
  private async validarAgendaDeEdicion(
    order: Order,
    dto: QuoteOrderDto,
    distributorId: string | null,
  ): Promise<void> {
    const { timeSlotId, scheduledDate, cambiaFranja, cambiaAgenda } =
      agendaDeEdicion(order, dto);
    if (timeSlotId && cambiaFranja) {
      await this.timeSlots.assertSlotUsableTx(
        this.dataSource.manager,
        timeSlotId,
        distributorId,
      );
    }
    if (cambiaAgenda && timeSlotId && scheduledDate) {
      if (dto.scheduledDate === undefined && scheduledDate < diaArgentino()) {
        throw new BadRequestException(
          'La fecha agendada del pedido ya pasó: indicá una fecha nueva (scheduledDate) para cambiar la franja',
        );
      }
      await this.timeSlots.assertSlotAvailable(
        timeSlotId,
        scheduledDate,
        distributorId,
      );
    }
  }

  /** La zona que el pedido ya tiene, para recotizarla sin cambiar la dirección. */
  private zonaDelPedido(order: Order): ZonaCotizada | null {
    const calculo = zonaGuardada(order);
    if (!calculo) return null;
    return {
      id: order.coverageZoneId ?? '',
      name: order.zoneName ?? '',
      type: calculo.type,
      value: calculo.value,
    };
  }
}

type ZonaCotizada = ZonaParaRecargo & { id: string; name: string };
