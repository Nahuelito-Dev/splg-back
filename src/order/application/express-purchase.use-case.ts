import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { RoleType } from '../../common/constants/role-type.enum';
import { DistributorService } from '../../distributor/distributor.service';
import { UserAddressService } from '../../user-address/user-address.service';
import { UserAddress } from '../../user-address/entities/user-address.entity';
import { CreateOrderDto } from '../dto/create-order.dto';
import {
  ExpressPreviewResponseDto,
  ExpressPurchaseDto,
} from '../dto/express.dto';
import { QuoteOrderDto } from '../dto/quote-order.dto';
import {
  Order,
  OrderDeliveryMode,
  OrderStatus,
} from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { CreateOrderResult, CreateOrderUseCase } from './create-order.use-case';
import { ExpressAvailabilityService } from './express-availability.service';
import { QuoteOrderUseCase } from './quote-order.use-case';
import { CODIGOS_DE_ERROR, conCodigo } from '../../common/errors/con-codigo';
import { assertMedioDePagoAceptado } from '../domain/medio-de-pago-aceptado';

interface CompraExpress {
  address: UserAddress;
  gasCylinderId: string;
  quantity: number;
}

/**
 * CU-147: la compra express en un solo paso. Con la dirección predeterminada del
 * cliente y su garrafa habitual (la de su última compra, o la que mande), evalúa
 * la modalidad (cobertura, horario, moto cerca), muestra el precio final con el
 * recargo y, con la confirmación, crea el pedido en modalidad express por el
 * mismo camino que `POST /orders`: el despacho a la moto más cercana (CU-149) lo
 * dispara el alta.
 */
@Injectable()
export class ExpressPurchaseUseCase {
  constructor(
    private readonly dataSource: DataSource,
    private readonly addresses: UserAddressService,
    private readonly express: ExpressAvailabilityService,
    private readonly quoteOrder: QuoteOrderUseCase,
    private readonly createOrder: CreateOrderUseCase,
    private readonly distributors: DistributorService,
  ) {}

  /** Pasos 2 a 5: lo que el cliente va a confirmar. No escribe nada. */
  async preview(
    dto: ExpressPurchaseDto,
    customerId: string,
    distributorId: string | null,
  ): Promise<ExpressPreviewResponseDto> {
    assertMedioDePagoAceptado(dto.paymentMethod);
    const distribuidora = await this.distribuidora(distributorId);
    const compra = await this.resolver(dto, customerId, distribuidora);
    const disponibilidad = await this.express.evaluar(
      distribuidora,
      compra.address,
    );

    const base = {
      address: {
        addressId: compra.address.addressId,
        street: compra.address.street,
        city: compra.address.city,
      },
      item: {
        gasCylinderId: compra.gasCylinderId,
        quantity: compra.quantity,
      },
    };
    if (!disponibilidad.available) {
      return {
        available: false,
        reason: disponibilidad.reason,
        message: disponibilidad.message,
        fallback: 'scheduled',
        ...base,
        quote: null,
        estimatedMinutes: null,
      };
    }

    const quote = await this.quoteOrder.execute(
      this.cuerpoDeCotizacion(dto, customerId, compra),
      distribuidora,
      { userId: customerId, role: RoleType.CUSTOMER },
    );
    return {
      available: true,
      reason: null,
      message: null,
      fallback: null,
      ...base,
      quote,
      estimatedMinutes: disponibilidad.settings.estimatedMinutes,
    };
  }

  /** Pasos 6 a 8: confirma. 409 `EXPRESS_NOT_AVAILABLE` si dejó de estar disponible. */
  async buy(
    dto: ExpressPurchaseDto,
    customerId: string,
    distributorId: string | null,
  ): Promise<CreateOrderResult> {
    assertMedioDePagoAceptado(dto.paymentMethod);
    const distribuidora = await this.distribuidora(distributorId);
    const compra = await this.resolver(dto, customerId, distribuidora);
    const pedido = Object.assign(new CreateOrderDto(), {
      customerId,
      addressId: compra.address.addressId,
      items: [
        {
          gasCylinderId: compra.gasCylinderId,
          quantity: compra.quantity,
          unitPrice: 0,
        },
      ],
      paymentMethod: dto.paymentMethod,
      notificationToken: dto.notificationToken,
      deliveryMode: OrderDeliveryMode.EXPRESS,
    });
    return this.createOrder.execute(pedido, distribuidora);
  }

  private async distribuidora(distributorId: string | null): Promise<string> {
    const id =
      distributorId ?? (await this.distributors.getDefault())?.distributorId;
    if (!id) {
      throw conCodigo(
        BadRequestException,
        400,
        'Falta la distribuidora: enviá el header X-Distributor (slug o id)',
        CODIGOS_DE_ERROR.MISSING_DISTRIBUTOR,
      );
    }
    return id;
  }

  private cuerpoDeCotizacion(
    dto: ExpressPurchaseDto,
    customerId: string,
    compra: CompraExpress,
  ): QuoteOrderDto {
    return Object.assign(new QuoteOrderDto(), {
      customerId,
      addressId: compra.address.addressId,
      items: [
        {
          gasCylinderId: compra.gasCylinderId,
          quantity: compra.quantity,
          unitPrice: 0,
        },
      ],
      paymentMethod: dto.paymentMethod,
      deliveryMode: OrderDeliveryMode.EXPRESS,
    });
  }

  /** CU-121: la dirección predeterminada y la garrafa habitual del cliente. */
  private async resolver(
    dto: ExpressPurchaseDto,
    customerId: string,
    distributorId: string,
  ): Promise<CompraExpress> {
    let address: UserAddress;
    try {
      address = await this.addresses.findDefaultByUserId(
        customerId,
        customerId,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException(
          'No tenés una dirección predeterminada: elegí una para comprar',
        );
      }
      throw error;
    }
    const gasCylinderId =
      dto.gasCylinderId ??
      (await this.garrafaHabitual(customerId, distributorId));
    if (!gasCylinderId) {
      throw new BadRequestException(
        'Todavía no tenés compras: elegí el tipo de garrafa',
      );
    }
    return { address, gasCylinderId, quantity: dto.quantity ?? 1 };
  }

  /** La garrafa del último pedido no cancelado del cliente en esta distribuidora. */
  private async garrafaHabitual(
    customerId: string,
    distributorId: string,
  ): Promise<string | null> {
    const fila = await this.dataSource.manager
      .createQueryBuilder(OrderItem, 'item')
      .innerJoin(Order, 'ord', 'ord.orderId = item.orderId')
      .select('item.gasCylinderId', 'gasCylinderId')
      .where('ord.customerId = :customerId', { customerId })
      .andWhere('ord.distributorId = :distributorId', { distributorId })
      .andWhere('ord.status != :cancelado', {
        cancelado: OrderStatus.CANCELLED,
      })
      .orderBy('ord.createdAt', 'DESC')
      .addOrderBy('item.quantity', 'DESC')
      .limit(1)
      .getRawOne<{ gasCylinderId: string }>();
    return fila?.gasCylinderId ?? null;
  }
}
