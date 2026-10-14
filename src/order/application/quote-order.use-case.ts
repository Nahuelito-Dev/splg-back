import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { RoleType } from '../../common/constants/role-type.enum';
import { DataSource } from 'typeorm';
import { TimeSlotService } from '../../time-slot/time-slot.service';
import { DistributorService } from '../../distributor/distributor.service';
import { InsufficientStockError } from '../../gascylinder/domain/errors/insufficient-stock.error';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { UserAddressService } from '../../user-address/user-address.service';
import { CreateOrderUseCase } from './create-order.use-case';
import { QuoteOrderDto, QuoteResponseDto } from '../dto/quote-order.dto';

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
  ) {}

  /**
   * @param actor quien cotiza: un cliente cotiza para sí mismo; un admin, para
   *   el cliente que indique (`customerId`, necesario sólo con `addressId`).
   */
  async execute(
    dto: QuoteOrderDto,
    distributorId: string | null,
    actor: { userId: string; role: RoleType },
  ): Promise<QuoteResponseDto> {
    if (!distributorId) {
      const porDefecto = await this.distributors.getDefault();
      distributorId = porDefecto?.distributorId ?? null;
    }
    if (dto.isReservation && !dto.scheduledDate) {
      throw new BadRequestException(
        'Una reserva requiere scheduledDate (fecha de entrega agendada)',
      );
    }

    const customerId =
      actor.role === RoleType.CUSTOMER ? actor.userId : dto.customerId;
    if (
      actor.role === RoleType.CUSTOMER &&
      dto.customerId &&
      dto.customerId !== actor.userId
    ) {
      throw new ForbiddenException(
        'No autorizado a cotizar pedidos para otro cliente',
      );
    }

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

    let zona = null;
    if (dto.addressId) {
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
    }

    // Mismo orden que el alta: los renglones se valorizan de a uno.
    let subtotal = new Decimal(0);
    const items: QuoteResponseDto['items'] = [];
    for (const item of dto.items) {
      const producto = await this.stock.leerParaCotizar(item.gasCylinderId);
      // Primero la distribuidora y después el stock, como el alta: con el id de
      // un producto ajeno no se distingue "sin stock" de "no pertenece".
      const renglon = this.createOrder.valorizarRenglon(
        producto,
        item,
        distributorId,
      );
      if (producto.stock < item.quantity) {
        throw new InsufficientStockError(producto.type);
      }
      subtotal = subtotal.plus(renglon.subtotal);
      items.push({
        gasCylinderId: item.gasCylinderId,
        title: renglon.checkoutItem.title,
        quantity: item.quantity,
        unitPrice: renglon.checkoutItem.unitPrice,
        subtotal: renglon.subtotal.toNumber(),
      });
    }

    const { totalAmount, zoneSurchargeAmount } =
      this.createOrder.calcularTotales(subtotal, zona, dto.paymentMethod);
    // La base guarda los montos con 2 decimales: la cotización devuelve lo
    // mismo que quedará en el pedido.
    const total = totalAmount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const deposit = new Decimal(
      dto.isReservation ? (dto.depositAmount ?? 0) : 0,
    );

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
    res.paymentSurcharge = total
      .minus(subtotal)
      .minus(zoneSurchargeAmount)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      .toNumber();
    res.deposit = deposit.toNumber();
    res.total = total.toNumber();
    res.balance = total.minus(deposit).toNumber();
    return res;
  }
}
