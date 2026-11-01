import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { totalBajoLaSenaPagada } from '../domain/deposit-cap';
import { DataSource } from 'typeorm';
import {
  Order,
  OrderDeliveryMode,
  OrderStatus,
  PaymentType,
} from '../entities/order.entity';
import {
  DispatchOffer,
  DispatchOfferStatus,
} from '../entities/dispatch-offer.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { OrderAddressChange } from '../entities/order-address-change.entity';
import { OrderStatusHistory } from '../entities/order-status-history.entity';
import { ChangeOrderAddressDto } from '../dto/change-order-address.dto';
import { CreateOrderUseCase } from './create-order.use-case';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { UserAddressService } from '../../user-address/user-address.service';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { MENSAJE_SENA_PAGADA } from '../domain/order-editable';
import { RedisService } from '../../redis/redis.service';
import { errorMessage } from '../../common/errors/error-message';

export const MENSAJE_PEDIDO_YA_SALIO =
  'El pedido ya salió o fue entregado: no se puede cambiar la dirección';
export const MENSAJE_RECARGO_DISTINTO =
  'El recargo de la zona nueva es distinto del original y el pedido es de pago en línea: cancelalo y hacelo de nuevo con la dirección que querés';
export const MENSAJE_EXPRESS_NO_CAMBIA =
  'Un pedido express no cambia de dirección: la cobertura, el horario y la moto se evaluaron con la dirección original. Cancelalo y creá uno nuevo';
export const MENSAJE_MISMA_DIRECCION =
  'La dirección nueva es la misma que la actual';

type CambioAplicado = {
  order: Order;
  ofertasCerradas: DispatchOffer[];
  choferUserId: string | null;
  fromAddressId: string;
};

/**
 * CU-127: el cliente dueño cambia la dirección de entrega de un pedido
 * PENDIENTE o ACEPTADO. En una transacción con lock sobre el pedido:
 *
 * 1. la dirección nueva tiene que ser del cliente y caer en una zona de
 *    cobertura de la distribuidora del pedido (misma consulta del alta);
 * 2. el recargo de la zona nueva se compara con el del pedido: en pago en
 *    línea el importe ya lo tomó la pasarela, así que si cambia se rechaza (409);
 *    en efectivo se recalcula el total;
 * 3. se guarda la dirección, el punto de entrega (contra el que se mide la
 *    llegada del chofer), el snapshot de la zona y el cambio en
 *    `order_address_change` con la dirección anterior, quién y el motivo.
 *
 * Después: las ofertas vivas del pedido pendiente (hechas con el punto viejo) se
 * vencen y se vuelve a ofrecer; al chofer asignado se le avisa por su id de
 * usuario; el panel se entera con `order:address-changed`.
 */
@Injectable()
export class ChangeOrderAddressUseCase {
  private readonly logger = new Logger(ChangeOrderAddressUseCase.name);

  private static readonly LOCK_TTL_MS = 5000;
  private static readonly LOCK_ESPERA_MS = 3000;

  constructor(
    private readonly dataSource: DataSource,
    private readonly create: CreateOrderUseCase,
    private readonly addresses: UserAddressService,
    private readonly orders: OrderRepositoryPort,
    private readonly realtime: RealtimeDispatchPort,
    private readonly dispatchOrchestrator: DispatchOrchestratorService,
    private readonly redis: RedisService,
  ) {}

  async execute(
    orderId: string,
    dto: ChangeOrderAddressDto,
    customerUserId: string,
    distributorId: string | null,
  ): Promise<Order> {
    // Mismo lock que el despacho y la edición: una oferta no se arma con el
    // punto de entrega de antes del cambio.
    const bloqueo = await this.redis.withLock(
      `dispatch:offer:${orderId}`,
      ChangeOrderAddressUseCase.LOCK_TTL_MS,
      () => this.enTransaccion(orderId, dto, customerUserId, distributorId),
      ChangeOrderAddressUseCase.LOCK_ESPERA_MS,
    );
    if (!bloqueo.obtenido) {
      throw new ConflictException(
        'El pedido se está despachando en este momento: probá de nuevo en unos segundos',
      );
    }
    return this.efectosPosteriores(bloqueo.valor);
  }

  private async enTransaccion(
    orderId: string,
    dto: ChangeOrderAddressDto,
    customerUserId: string,
    distributorId: string | null,
  ): Promise<CambioAplicado> {
    return this.dataSource.transaction(async (manager) => {
      // Alias `ord` y `FOR UPDATE OF`: ver CancelOrderUseCase.
      const order = await manager
        .createQueryBuilder(Order, 'ord')
        .setLock('pessimistic_write', undefined, ['ord'])
        .where('ord.orderId = :id', { id: orderId })
        .getOne();

      if (
        !order ||
        order.customerId !== customerUserId ||
        (distributorId && order.distributorId !== distributorId)
      ) {
        throw new NotFoundException(`Order with ID: ${orderId} not found`);
      }

      // El estado se re-chequea ADENTRO del lock: si el pedido salió en
      // paralelo, este cambio falla sin escribir.
      if (
        order.status === OrderStatus.ON_THE_WAY ||
        order.status === OrderStatus.DELIVERED
      ) {
        throw new ConflictException(MENSAJE_PEDIDO_YA_SALIO);
      }
      if (
        order.status !== OrderStatus.PENDING &&
        order.status !== OrderStatus.ACCEPTED
      ) {
        throw new ConflictException(
          `Sólo se cambia la dirección de un pedido pendiente o aceptado (estado actual: ${order.status})`,
        );
      }

      // Mismo criterio que `motivoNoEditable`: el express se evaluó para esa
      // dirección. Se rechaza antes de mirar la dirección nueva.
      const esExpress = order.deliveryMode === OrderDeliveryMode.EXPRESS;
      if (esExpress) {
        throw new ConflictException(MENSAJE_EXPRESS_NO_CAMBIA);
      }

      const address = await this.addresses.buscarDelUsuario(
        dto.addressId,
        order.customerId,
      );
      if (!address) throw new NotFoundException('Dirección no encontrada');
      if (address.addressId === order.addressId) {
        throw new BadRequestException(MENSAJE_MISMA_DIRECCION);
      }

      // Fuera de cobertura: 400 antes de tocar nada.
      const zona = await this.create.resolverZona(order.distributorId, address);
      // El medio de pago no cambia: se conserva el % con que se calculó el pedido.
      const paymentSurchargePercentage =
        await this.create.porcentajeDeRecargoDelPedido(
          order,
          order.paymentMethod,
        );
      const { totalAmount, zoneSurchargeAmount, paymentSurchargeAmount } =
        this.create.calcularTotales(
          order.subtotalItems,
          zona,
          paymentSurchargePercentage,
          // Defensivo: mientras siga express el recargo se conserva en el total.
          esExpress ? order.expressSurchargeAmount : 0,
        );

      const cambiaElRecargo =
        zoneSurchargeAmount.toNumber() !== Number(order.zoneSurchargeAmount);
      const pagoEnLinea = order.paymentType === PaymentType.ONLINE;
      if (pagoEnLinea && cambiaElRecargo) {
        throw new ConflictException(MENSAJE_RECARGO_DISTINTO);
      }

      const totalAnterior = order.totalAmount;
      if (!pagoEnLinea) {
        if (
          order.depositPaid &&
          totalBajoLaSenaPagada(totalAmount, order.depositAmount)
        ) {
          throw new ConflictException(MENSAJE_SENA_PAGADA);
        }
        order.zoneSurchargeAmount = zoneSurchargeAmount.toNumber();
        order.paymentSurchargeAmount = paymentSurchargeAmount.toNumber();
        order.paymentSurchargePercentage = paymentSurchargePercentage;
        order.totalAmount = totalAmount.toNumber();
      }

      const fromAddressId = order.addressId;
      // El chofer se lee DESPUÉS del lock y en una consulta aparte: en READ
      // COMMITTED, un JOIN que esperó el lock re-lee el pedido pero no el
      // chofer que otra transacción le asignó en el medio, y no se le avisaría.
      const choferUserId = order.deliveryId
        ? ((
            await manager.findOne(Delivery, {
              where: { deliveryId: order.deliveryId },
            })
          )?.userId ?? null)
        : null;
      order.addressId = address.addressId;
      order.deliveryPoint = address.location ?? null;
      order.coverageZoneId = zona?.id ?? null;
      order.zoneName = zona?.name ?? null;
      order.zoneSurchargeType = zona?.type ?? null;
      order.zoneSurchargeValue = zona?.value ?? null;

      // Pendiente: las ofertas vivas se hicieron con el punto viejo.
      let ofertasCerradas: DispatchOffer[] = [];
      if (order.status === OrderStatus.PENDING) {
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

      await manager.save(order);
      await manager.save(
        manager.create(OrderAddressChange, {
          orderId: order.orderId,
          fromAddressId,
          toAddressId: address.addressId,
          changedByUserId: customerUserId,
          reason: dto.reason ?? null,
        }),
      );
      await manager.insert(OrderStatusHistory, {
        orderId: order.orderId,
        fromStatus: order.status,
        toStatus: order.status,
        changedByUserId: customerUserId,
        reason: this.detalle(dto.reason, totalAnterior, order.totalAmount),
      });

      return { order, ofertasCerradas, choferUserId, fromAddressId };
    });
  }

  private detalle(
    motivo: string | undefined,
    totalAnterior: number,
    totalNuevo: number,
  ): string {
    const total =
      totalAnterior !== totalNuevo
        ? `. Total: ${totalAnterior} → ${totalNuevo}`
        : '';
    const porque = motivo ? ` (${motivo})` : '';
    return `Dirección de entrega cambiada por el cliente${porque}${total}`;
  }

  /**
   * Después del commit: relectura, avisos y reoferta. Nada de esto convierte en
   * error un cambio ya confirmado.
   */
  private async efectosPosteriores(tx: CambioAplicado): Promise<Order> {
    const { order, ofertasCerradas, choferUserId, fromAddressId } = tx;
    const completo =
      (await this.orders.findByIdFull(order.orderId).catch((e: unknown) => {
        this.logger.error(
          `Pedido ${order.orderId}: dirección cambiada, pero no se pudo releer: ${errorMessage(e)}`,
        );
        return null;
      })) ?? order;

    try {
      const payload = {
        orderId: order.orderId,
        distributorId: order.distributorId,
        fromAddressId,
        toAddressId: order.addressId,
        totalAmount: order.totalAmount,
        status: order.status,
      };
      if (choferUserId) {
        this.realtime.notifyDriverOrderAddressChanged(choferUserId, {
          ...payload,
          message: 'El cliente cambió la dirección de entrega del pedido',
        });
      }
      for (const oferta of ofertasCerradas) {
        this.realtime.notifyDriverOrderCancelled(oferta.driverId, {
          orderId: order.orderId,
          message: 'El pedido fue modificado: la oferta ya no está vigente',
        });
      }
      this.realtime.notifyAdmins(
        'order:address-changed',
        payload,
        order.distributorId,
      );
    } catch (error) {
      this.logger.error(
        `Pedido ${order.orderId}: dirección cambiada, pero falló un aviso: ${errorMessage(error)}`,
      );
    }

    if (order.status === OrderStatus.PENDING) {
      await this.dispatchOrchestrator
        .offerToNextDriver(completo)
        .catch(() => undefined);
    }
    return completo;
  }
}
