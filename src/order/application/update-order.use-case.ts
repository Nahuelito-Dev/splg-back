import {
  ConflictException,
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { totalBajoLaSenaPagada } from '../domain/deposit-cap';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { DataSource } from 'typeorm';

import { Order, PaymentMethod } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import {
  DispatchOffer,
  DispatchOfferStatus,
} from '../entities/dispatch-offer.entity';
import { OrderAddressChange } from '../entities/order-address-change.entity';
import { UpdateOrderDto } from '../dto/update-order.dto';
import { CreateOrderUseCase, paymentTypeDe } from './create-order.use-case';
import { UserAddressService } from '../../user-address/user-address.service';
import { TimeSlotService } from '../../time-slot/time-slot.service';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import type { ZonaParaRecargo } from '../../coverage-zone/coverage-zone-pricing.service';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import {
  MENSAJE_NO_PASAR_A_MERCADOPAGO,
  MENSAJE_SENA_PAGADA,
  agendaDeEdicion,
  mensajeDeNoEditable,
  motivoNoEditable,
  zonaGuardada,
} from '../domain/order-editable';
import { OrderStatusHistory } from '../entities/order-status-history.entity';
import { RoleType } from '../../common/constants/role-type.enum';
import { RedisService } from '../../redis/redis.service';
import { marcarRespuestaIncompleta } from '../../common/interceptors/respuesta-incompleta';
import { errorMessage } from '../../common/errors/error-message';

/** Lo que la transacción de la edición devuelve para los efectos posteriores. */
type EdicionAplicada = {
  sinCambios: false;
  orderId: string;
  saved: Order;
  totalAnterior: number;
  ofertasCerradas: DispatchOffer[];
  cambioRelevante: boolean;
};
type ResultadoEdicion = EdicionAplicada | { sinCambios: true; orderId: string };

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
 * Lo usan el admin y el CLIENTE DUEÑO. Para el cliente: un pedido ajeno es 404
 * (como `GET /orders/:id`), el 409 por chofer asignado lleva un mensaje propio
 * y la edición deja una anotación en el historial de estados con el detalle.
 *
 * Fuera de alcance a propósito: pedidos con pago online (MercadoPago), porque
 * el checkout ya creado quedaría con otro monto.
 */
@Injectable()
export class UpdateOrderUseCase {
  private readonly logger = new Logger(UpdateOrderUseCase.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly create: CreateOrderUseCase,
    private readonly addresses: UserAddressService,
    private readonly timeSlotService: TimeSlotService,
    private readonly stock: GasCylinderService,
    private readonly orders: OrderRepositoryPort,
    private readonly realtime: RealtimeDispatchPort,
    private readonly dispatchOrchestrator: DispatchOrchestratorService,
    private readonly redis: RedisService,
  ) {}

  async execute(
    orderId: string,
    dto: UpdateOrderDto,
    actorUserId: string,
    distributorId: string | null,
    actorRole: RoleType = RoleType.ADMIN,
  ): Promise<Order> {
    // Mismo lock que el despacho (`DispatchOrchestratorService.offerToNextDriver`):
    // una oferta no se arma con la lectura de antes de la edición ni se inserta
    // después de que ésta vencía las ofertas vivas. Si el despacho está
    // ofreciendo este pedido (o hay otra edición en curso) se espera unos segundos
    // antes de responder 409.
    const bloqueo = await this.redis.withLock(
      `dispatch:offer:${orderId}`,
      UpdateOrderUseCase.LOCK_TTL_MS,
      () =>
        this.enTransaccion(orderId, dto, actorUserId, distributorId, actorRole),
      UpdateOrderUseCase.LOCK_ESPERA_MS,
    );
    if (!bloqueo.obtenido) {
      throw new ConflictException(
        'El pedido se está despachando en este momento: probá de nuevo en unos segundos',
      );
    }
    const tx = bloqueo.valor;
    if (tx.sinCambios) return this.releerOrFail(orderId);
    return this.efectosPosteriores(tx);
  }

  private static readonly LOCK_TTL_MS = 5000;
  /** Cuánto espera el lock si el despacho u otra edición lo tienen. */
  private static readonly LOCK_ESPERA_MS = 3000;

  private async enTransaccion(
    orderId: string,
    dto: UpdateOrderDto,
    actorUserId: string,
    distributorId: string | null,
    actorRole: RoleType,
  ): Promise<ResultadoEdicion> {
    const esCliente = actorRole === RoleType.CUSTOMER;
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

      if (
        !order ||
        (distributorId && order.distributorId !== distributorId) ||
        (esCliente && order.customerId !== actorUserId)
      ) {
        throw new NotFoundException(`Order with ID: ${orderId} not found`);
      }

      this.assertEditable(order, dto, esCliente);

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
      const cambiaItems =
        Boolean(dto.items) &&
        this.cambiaronLosRenglones(order.items, dto.items);

      // Dirección: tiene que ser del cliente del pedido; cambia el punto de
      // entrega, la zona y deja el cambio en el historial de direcciones.
      let zone: ZonaParaRecargo | null = zonaGuardada(order);
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
      const { timeSlotId, scheduledDate, cambiaAgenda, cambiaFranja } =
        agendaDeEdicion(order, dto);
      if (timeSlotId && cambiaFranja) {
        await this.timeSlotService.assertSlotUsableTx(
          manager,
          timeSlotId,
          order.distributorId,
        );
      }
      // Una fecha nueva nunca puede ser pasada, con o sin franja.
      if (
        dto.scheduledDate &&
        dto.scheduledDate !== order.scheduledDate &&
        dto.scheduledDate < diaArgentino()
      ) {
        throw new BadRequestException(
          'scheduledDate no puede ser una fecha pasada',
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
      // Un PATCH que no cambia nada no escribe: ni historial, ni evento, ni
      // reoferta.
      const cambiaNotas = dto.notes !== undefined && dto.notes !== order.notes;
      if (
        !cambiaItems &&
        !cambiaDireccion &&
        !cambiaPago &&
        !cambiaAgenda &&
        !cambiaNotas
      ) {
        await queryRunner.rollbackTransaction();
        return { sinCambios: true, orderId };
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
        // Ajusta la reserva por la diferencia neta de cada garrafa (devolver todo
        // y reservar de nuevo fallaba si la garrafa tenía reservas de más).
        await this.stock.reajustarReserva(manager, order.items, dto.items);
        // `remove` y no `delete`: el borrado de un renglón reemplazado deja una
        // Baja física en la auditoría, con sus campos (incluido orderId).
        await manager.remove(OrderItem, order.items);
        const reservado = await this.create.reservarRenglones(
          manager,
          dto.items,
          order.distributorId,
          true,
        );
        order.items = reservado.orderItems;
        subtotalItems = reservado.subtotalItems.toNumber();
      }

      // El total sólo se recalcula si cambian renglones, dirección/zona o
      // medio de pago: editar notas o franja no lo toca.
      if (cambiaItems || cambiaDireccion || cambiaPago) {
        const paymentSurchargePercentage =
          await this.create.porcentajeDeRecargoDelPedido(order, paymentMethod);
        const { totalAmount, zoneSurchargeAmount, paymentSurchargeAmount } =
          this.create.calcularTotales(
            subtotalItems,
            zone,
            paymentSurchargePercentage,
          );
        if (
          order.depositPaid &&
          totalBajoLaSenaPagada(totalAmount, order.depositAmount)
        ) {
          throw new ConflictException(MENSAJE_SENA_PAGADA);
        }
        order.subtotalItems = subtotalItems;
        order.zoneSurchargeAmount = zoneSurchargeAmount.toNumber();
        order.paymentSurchargeAmount = paymentSurchargeAmount.toNumber();
        order.paymentSurchargePercentage = paymentSurchargePercentage;
        order.totalAmount = totalAmount.toNumber();
      }
      order.paymentMethod = paymentMethod;
      order.paymentType = paymentTypeDe(paymentMethod);
      if (cambiaNotas) order.notes = dto.notes ?? null;

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
      if (esCliente) {
        await manager.insert(OrderStatusHistory, {
          orderId: order.orderId,
          fromStatus: order.status,
          toStatus: order.status,
          changedByUserId: actorUserId,
          reason: this.detalleDeLaEdicion(dto, {
            cambiaItems,
            cambiaDireccion,
            cambiaPago,
            cambiaAgenda,
            cambiaNotas,
            totalAnterior,
            totalNuevo: order.totalAmount,
          }),
        });
      }
      await queryRunner.commitTransaction();
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }

    return {
      sinCambios: false,
      orderId,
      saved,
      totalAnterior,
      ofertasCerradas,
      cambioRelevante,
    };
  }

  /** El pedido tal cual está, para el PATCH que no cambió nada. */
  private async releerOrFail(orderId: string): Promise<Order> {
    const result = await this.orders.findByIdFull(orderId);
    if (!result) {
      throw new NotFoundException(`Order with ID: ${orderId} not found`);
    }
    return result;
  }

  /**
   * Después del commit: relectura, avisos y reoferta. Nada de esto puede
   * convertir en error una edición ya confirmada (un reintento con la misma
   * `Idempotency-Key` la repetiría): si falla la relectura se responde con lo
   * guardado y se marca la respuesta como incompleta.
   */
  private async efectosPosteriores(tx: EdicionAplicada): Promise<Order> {
    const { saved, totalAnterior, ofertasCerradas, cambioRelevante } = tx;
    let result: Order;
    try {
      const completo = await this.orders.findByIdFull(saved.orderId);
      if (!completo) throw new InternalServerErrorException('sin pedido');
      result = completo;
    } catch (error) {
      this.logger.error(
        `Pedido ${saved.orderId} editado, pero no se pudo releer: ${errorMessage(error)}`,
      );
      marcarRespuestaIncompleta();
      result = saved;
    }

    try {
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
    } catch (error) {
      this.logger.error(
        `Pedido ${saved.orderId} editado, pero falló un aviso: ${errorMessage(error)}`,
      );
    }
    if (cambioRelevante) {
      await this.dispatchOrchestrator
        .offerToNextDriver(result)
        .catch(() => undefined);
    }
    return result;
  }

  /** ¿Los renglones nuevos difieren de los guardados (garrafa y cantidad)? */
  private cambiaronLosRenglones(
    actuales: ReadonlyArray<{ gasCylinderId: string; quantity: number }>,
    nuevos:
      | ReadonlyArray<{ gasCylinderId: string; quantity: number }>
      | undefined,
  ): boolean {
    if (!nuevos) return false;
    const mapa = (
      r: ReadonlyArray<{ gasCylinderId: string; quantity: number }>,
    ) => new Map(r.map((i) => [i.gasCylinderId, i.quantity]));
    const a = mapa(actuales);
    const n = mapa(nuevos);
    if (a.size !== n.size) return true;
    for (const [id, cantidad] of n) if (a.get(id) !== cantidad) return true;
    return false;
  }

  /** Sólo se edita un pedido pendiente, sin chofer y sin pago online. */
  private assertEditable(
    order: Order,
    dto: UpdateOrderDto,
    esCliente: boolean,
  ): void {
    const noEditable = motivoNoEditable(order);
    if (noEditable) {
      throw new ConflictException(
        mensajeDeNoEditable(order, noEditable, esCliente),
      );
    }
    if (dto.paymentMethod === PaymentMethod.MERCADOPAGO) {
      throw new BadRequestException(MENSAJE_NO_PASAR_A_MERCADOPAGO);
    }
    if (dto.paymentMethod === PaymentMethod.ACCOUNT) {
      throw new BadRequestException(
        'La venta a cuenta corriente se elige al crear el pedido desde el panel',
      );
    }
  }

  /** Texto de la anotación del historial: qué tocó el cliente. */
  private detalleDeLaEdicion(
    dto: UpdateOrderDto,
    c: {
      cambiaItems: boolean;
      cambiaDireccion: boolean;
      cambiaPago: boolean;
      cambiaAgenda: boolean;
      cambiaNotas: boolean;
      totalAnterior: number;
      totalNuevo: number;
    },
  ): string {
    const partes: string[] = [];
    if (c.cambiaItems) partes.push('renglones');
    if (c.cambiaDireccion) partes.push('dirección');
    if (c.cambiaPago) partes.push('medio de pago');
    if (c.cambiaAgenda) partes.push('franja o fecha');
    if (c.cambiaNotas) partes.push('notas');
    const cambios = partes.length > 0 ? partes.join(', ') : 'sin cambios';
    const total =
      c.totalAnterior !== c.totalNuevo
        ? `. Total: ${c.totalAnterior} → ${c.totalNuevo}`
        : '';
    return `Pedido modificado por el cliente: ${cambios}${total}`;
  }
}
