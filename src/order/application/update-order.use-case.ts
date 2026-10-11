import {
  ConflictException,
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { DataSource } from 'typeorm';

import { Order, PaymentMethod, PaymentType } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import {
  DispatchOffer,
  DispatchOfferStatus,
} from '../entities/dispatch-offer.entity';
import { OrderAddressChange } from '../entities/order-address-change.entity';
import { UpdateOrderDto } from '../dto/update-order.dto';
import { CreateOrderUseCase } from './create-order.use-case';
import { UserAddressService } from '../../user-address/user-address.service';
import { TimeSlotService } from '../../time-slot/time-slot.service';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import type { ZonaParaRecargo } from '../../coverage-zone/coverage-zone-pricing.service';
import { CoverageZoneSurchargeType } from '../../coverage-zone/entities/coverage-zone.entity';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { motivoNoEditable } from '../domain/order-editable';

/**
 * Caso de uso: editar un pedido PENDIENTE (sin chofer asignado).
 *
 * Reusa las reglas del alta (`CreateOrderUseCase`: zona de cobertura, reserva
 * de stock con lock, precios de servidor, recargos) y corre en UNA transacción
 * con lock pesimista sobre el pedido: el estado se re-chequea adentro, así que
 * si el pedido se acepta o se cancela en paralelo, esta edición falla con 409
 * sin tocar stock. Si cambian los renglones, se devuelve el stock viejo y se
 * reserva el nuevo en la misma transacción.
 *
 * Fuera de alcance a propósito: pedidos con pago online (MercadoPago), porque
 * el checkout ya creado quedaría con otro monto.
 */
@Injectable()
export class UpdateOrderUseCase {
  constructor(
    private readonly dataSource: DataSource,
    private readonly create: CreateOrderUseCase,
    private readonly addresses: UserAddressService,
    private readonly timeSlotService: TimeSlotService,
    private readonly stock: GasCylinderService,
    private readonly orders: OrderRepositoryPort,
    private readonly realtime: RealtimeDispatchPort,
    private readonly dispatchOrchestrator: DispatchOrchestratorService,
  ) {}

  async execute(
    orderId: string,
    dto: UpdateOrderDto,
    actorUserId: string,
    distributorId: string | null,
  ): Promise<Order> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let saved: Order;
    let totalAnterior: number;
    let ofertasCerradas: DispatchOffer[] = [];
    let cambioRelevante = false;
    try {
      const manager = queryRunner.manager;
      // Alias `ord` y `FOR UPDATE OF`: ver CancelOrderUseCase.
      const order = await manager
        .createQueryBuilder(Order, 'ord')
        .setLock('pessimistic_write', undefined, ['ord'])
        .where('ord.orderId = :id', { id: orderId })
        .getOne();

      if (!order || (distributorId && order.distributorId !== distributorId)) {
        throw new NotFoundException(`Order with ID: ${orderId} not found`);
      }

      this.assertEditable(order, dto);

      // Los renglones se leen DESPUÉS del lock y en una consulta aparte: un
      // SELECT que esperó el lock re-lee el pedido pero no los renglones que
      // otra edición cambió en el medio (READ COMMITTED), y se devolvería
      // stock de renglones viejos.
      order.items = await manager.find(OrderItem, {
        where: { orderId: order.orderId },
      });
      totalAnterior = order.totalAmount;

      const paymentMethod = dto.paymentMethod ?? order.paymentMethod;
      const cambiaPago = paymentMethod !== order.paymentMethod;
      const cambiaItems = Boolean(dto.items);

      // Dirección: tiene que ser del cliente del pedido; cambia el punto de
      // entrega, la zona y deja el cambio en el historial de direcciones.
      let zone: ZonaParaRecargo | null = this.zonaGuardada(order);
      const cambiaDireccion = Boolean(
        dto.addressId && dto.addressId !== order.addressId,
      );
      if (dto.addressId && cambiaDireccion) {
        const address = await this.addresses.buscarDelUsuario(
          dto.addressId,
          order.customerId,
        );
        if (!address) throw new NotFoundException('Dirección no encontrada');
        const nuevaZona = await this.create.resolverZona(
          order.distributorId,
          address,
        );
        zone = nuevaZona;
        await manager.save(
          manager.create(OrderAddressChange, {
            orderId: order.orderId,
            fromAddressId: order.addressId,
            toAddressId: address.addressId,
            changedByUserId: actorUserId,
            reason: 'Edición del pedido',
          }),
        );
        order.addressId = address.addressId;
        order.deliveryPoint = address.location ?? null;
        order.coverageZoneId = nuevaZona?.id ?? null;
        order.zoneName = nuevaZona?.name ?? null;
        order.zoneSurchargeType = nuevaZona?.type ?? null;
        order.zoneSurchargeValue = nuevaZona?.value ?? null;
      }

      // Franja y fecha. `timeSlotId: null` saca la franja. El cupo se valida
      // sólo si cambia la franja o la fecha (el propio pedido ya cuenta en la
      // que tiene) y siempre contra la fecha que corresponde.
      const timeSlotId =
        dto.timeSlotId !== undefined ? dto.timeSlotId : order.timeSlotId;
      const scheduledDate = dto.scheduledDate ?? order.scheduledDate ?? null;
      const cambiaAgenda =
        timeSlotId !== order.timeSlotId ||
        scheduledDate !== (order.scheduledDate ?? null);
      if (timeSlotId && timeSlotId !== order.timeSlotId) {
        await this.timeSlotService.assertSlotUsableTx(
          manager,
          timeSlotId,
          order.distributorId,
        );
      }
      if (cambiaAgenda && timeSlotId && scheduledDate) {
        const hoy = diaArgentino();
        if (dto.scheduledDate === undefined && scheduledDate < hoy) {
          throw new BadRequestException(
            'La fecha agendada del pedido ya pasó: indicá una fecha nueva (scheduledDate) para cambiar la franja',
          );
        }
        await this.timeSlotService.assertSlotAvailableTx(
          manager,
          timeSlotId,
          scheduledDate,
          order.distributorId,
        );
      }
      order.timeSlotId = timeSlotId;
      order.scheduledDate = scheduledDate;

      // Renglones: se devuelve el stock viejo y se reserva el nuevo.
      let subtotalItems = order.subtotalItems;
      if (dto.items) {
        // Un solo orden de locks para devolver y reservar: la unión de ids
        // viejos y nuevos, por id ascendente.
        await this.stock.bloquearEnOrden(manager, [
          ...order.items.map((i) => i.gasCylinderId),
          ...dto.items.map((i) => i.gasCylinderId),
        ]);
        await this.stock.restituirStock(manager, order.items);
        // `remove` y no `delete`: el borrado de un renglón reemplazado deja una
        // Baja física en la auditoría, con sus campos (incluido orderId).
        await manager.remove(OrderItem, order.items);
        const reservado = await this.create.reservarRenglones(
          manager,
          dto.items,
          order.distributorId,
        );
        order.items = reservado.orderItems;
        subtotalItems = reservado.subtotalItems.toNumber();
      }

      // El total sólo se recalcula si cambian renglones, dirección/zona o
      // medio de pago: editar notas o franja no lo toca.
      if (cambiaItems || cambiaDireccion || cambiaPago) {
        const { totalAmount, zoneSurchargeAmount } =
          this.create.calcularTotales(subtotalItems, zone, paymentMethod);
        order.subtotalItems = subtotalItems;
        order.zoneSurchargeAmount = zoneSurchargeAmount.toNumber();
        order.totalAmount = totalAmount.toNumber();
      }
      order.paymentMethod = paymentMethod;
      order.paymentType =
        paymentMethod === PaymentMethod.CASH
          ? PaymentType.CASH
          : PaymentType.ONLINE;
      if (dto.notes !== undefined) order.notes = dto.notes;

      // Una oferta de despacho viva quedó con datos viejos: se vence en la
      // misma transacción (después se avisa al chofer y se vuelve a ofrecer).
      cambioRelevante =
        cambiaItems || cambiaDireccion || cambiaPago || cambiaAgenda;
      if (cambioRelevante) {
        ofertasCerradas = await manager.find(DispatchOffer, {
          where: {
            orderId: order.orderId,
            status: DispatchOfferStatus.OFFERED,
          },
        });
        if (ofertasCerradas.length > 0) {
          await manager.update(
            DispatchOffer,
            { orderId: order.orderId, status: DispatchOfferStatus.OFFERED },
            { status: DispatchOfferStatus.SUPERSEDED },
          );
        }
      }

      saved = await manager.save(order);
      await queryRunner.commitTransaction();
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }

    const result = await this.orders.findByIdFull(saved.orderId);
    if (!result) {
      throw new InternalServerErrorException(
        'Pedido editado pero no recuperable',
      );
    }

    this.realtime.notifyAdmins(
      'order:updated',
      {
        orderId: saved.orderId,
        distributorId: saved.distributorId,
        totalAmount: saved.totalAmount,
        status: saved.status,
      },
      saved.distributorId,
    );
    // No hay un tipo de notificación push para "pedido modificado": se emite
    // el evento de tiempo real `order:updated` al cliente si cambió el total.
    if (saved.totalAmount !== totalAnterior) {
      this.realtime.notifyCustomer(saved.customerId, 'order:updated', {
        orderId: saved.orderId,
        totalAmount: saved.totalAmount,
        previousTotalAmount: totalAnterior,
      });
    }
    for (const oferta of ofertasCerradas) {
      this.realtime.notifyDriverOrderCancelled(oferta.driverId, {
        orderId: saved.orderId,
        message: 'El pedido fue modificado: la oferta ya no está vigente',
      });
    }
    if (cambioRelevante) {
      await this.dispatchOrchestrator
        .offerToNextDriver(result)
        .catch(() => undefined);
    }

    return result;
  }

  /** Sólo se edita un pedido pendiente, sin chofer y sin pago online. */
  private assertEditable(order: Order, dto: UpdateOrderDto): void {
    const noEditable = motivoNoEditable(order);
    if (noEditable) throw new ConflictException(noEditable.mensaje);
    if (dto.paymentMethod === PaymentMethod.MERCADOPAGO) {
      throw new BadRequestException(
        'No se puede pasar un pedido a MercadoPago al editarlo: cancelalo y creá uno nuevo',
      );
    }
  }

  /**
   * La zona que el pedido ya tenía (snapshot), para recalcular su recargo. Un
   * pedido sin snapshot pero con recargo guardado conserva ese monto como fijo.
   */
  private zonaGuardada(order: Order): ZonaParaRecargo | null {
    if (order.zoneSurchargeType && order.zoneSurchargeValue !== null) {
      return { type: order.zoneSurchargeType, value: order.zoneSurchargeValue };
    }
    if (order.zoneSurchargeAmount > 0) {
      return {
        type: CoverageZoneSurchargeType.FIXED,
        value: order.zoneSurchargeAmount,
      };
    }
    return null;
  }
}
