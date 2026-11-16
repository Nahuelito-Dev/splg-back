import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RoleType } from '../../common/constants/role-type.enum';
import { DistributorService } from '../../distributor/distributor.service';
import { UserAddressService } from '../../user-address/user-address.service';
import { OrderDeliveryMode } from '../entities/order.entity';
import {
  DeliveryOptionsQueryDto,
  DeliveryOptionsResponseDto,
} from '../dto/express.dto';
import { ExpressAvailabilityService } from './express-availability.service';

/**
 * CU-148: las modalidades de entrega que se le ofrecen al cliente para una
 * dirección, con su recargo y su tiempo estimado. La programada (reparto común)
 * siempre figura; la express sólo con cobertura, horario y una moto cerca. No
 * escribe nada.
 */
@Injectable()
export class DeliveryOptionsUseCase {
  constructor(
    private readonly addresses: UserAddressService,
    private readonly express: ExpressAvailabilityService,
    private readonly distributors: DistributorService,
  ) {}

  async execute(
    query: DeliveryOptionsQueryDto,
    distributorId: string | null,
    actor: { userId: string; role: RoleType },
  ): Promise<DeliveryOptionsResponseDto> {
    if (
      actor.role === RoleType.CUSTOMER &&
      query.customerId &&
      query.customerId !== actor.userId
    ) {
      throw new ForbiddenException(
        'No autorizado a consultar las opciones de otro cliente',
      );
    }
    const customerId =
      actor.role === RoleType.CUSTOMER ? actor.userId : query.customerId;
    if (!customerId) {
      throw new BadRequestException(
        'Indicá el cliente para consultar las opciones de entrega de su dirección',
      );
    }
    const address = await this.addresses.buscarDelUsuario(
      query.addressId,
      customerId,
    );
    if (!address) throw new NotFoundException('Dirección no encontrada');

    const distribuidora =
      distributorId ?? (await this.distributors.getDefault())?.distributorId;
    const express = distribuidora
      ? await this.express.evaluar(distribuidora, address)
      : null;
    const settings = express?.settings;

    return {
      addressId: address.addressId,
      options: [
        {
          mode: OrderDeliveryMode.STANDARD,
          available: true,
          reason: null,
          message: null,
          surchargeAmount: 0,
          estimatedMinutes: settings?.standardEstimatedMinutes ?? 180,
        },
        {
          mode: OrderDeliveryMode.EXPRESS,
          available: express?.available ?? false,
          reason: express ? express.reason : 'disabled',
          message: express
            ? express.message
            : 'La distribuidora no ofrece la modalidad express',
          surchargeAmount: express?.available
            ? express.settings.surchargeAmount
            : 0,
          estimatedMinutes: settings?.estimatedMinutes ?? 45,
        },
      ],
    };
  }
}
