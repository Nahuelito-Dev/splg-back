import {
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RoleType } from '../common/constants/role-type.enum';
import { DomainError } from '../common/errors/domain.error';
import { errorMessage, errorStatus } from '../common/errors/error-message';
import { DistributorService } from '../distributor/distributor.service';
import { DistributorStatus } from '../distributor/entities/distributor.entity';
import { QuoteOrderUseCase } from '../order/application/quote-order.use-case';
import { medioVigenteDeLaSugerencia } from '../order/domain/medio-de-pago-aceptado';
import { QuoteOrderDto, QuoteResponseDto } from '../order/dto/quote-order.dto';
import { GasCylinderService } from '../gascylinder/gascylinder.service';
import { GasCylinder } from '../gascylinder/entities/gascylinder.entity';
import { TimeSlotService } from '../time-slot/time-slot.service';
import { TimeSlot } from '../time-slot/entities/time-slot.entity';
import { UserAddressService } from '../user-address/user-address.service';
import { UserAddress } from '../user-address/entities/user-address.entity';
import {
  RepurchaseInvitation,
  RepurchaseInvitationStatus,
} from './entities/repurchase-invitation.entity';

/** Lo que una invitación necesita para mostrarse: el catálogo, la dirección y la franja de hoy. */
export interface DetalleDeInvitacion {
  garrafas: Map<string, GasCylinder>;
  direccion: UserAddress | null;
  franja: TimeSlot | null;
  /**
   * La cotización del pedido de hoy (la de `POST /orders/quote`: zona de la
   * dirección, medio de pago y promociones); de ella salen también el precio y
   * el subtotal de los renglones. `null` si la invitación ya no está abierta o
   * venció, o hoy el alta no la aceptaría (producto dado de baja, distribuidora
   * suspendida, sin stock, dirección fuera de cobertura).
   */
  cotizacion: QuoteResponseDto | null;
}

/**
 * Junta lo que la invitación sólo guarda por id (nombres y precios de hoy, la
 * dirección y la franja) para que la app muestre el pedido precargado.
 */
@Injectable()
export class RepurchaseInvitationDetailService {
  private readonly logger = new Logger(RepurchaseInvitationDetailService.name);

  constructor(
    private readonly catalogo: GasCylinderService,
    private readonly franjas: TimeSlotService,
    private readonly direcciones: UserAddressService,
    private readonly cotizador: QuoteOrderUseCase,
    private readonly distribuidoras: DistributorService,
  ) {}

  async detallar(
    invitacion: RepurchaseInvitation,
    ahora: Date = new Date(),
  ): Promise<DetalleDeInvitacion> {
    const garrafas = new Map<string, GasCylinder>();
    for (const item of invitacion.suggestedItems) {
      const garrafa = await this.sinNoEncontrado(() =>
        this.catalogo.findOne(item.gasCylinderId, invitacion.distributorId),
      );
      if (garrafa) garrafas.set(garrafa.gasCylinderId, garrafa);
    }
    const direccion = invitacion.addressId
      ? await this.direcciones.buscarDelUsuario(
          invitacion.addressId,
          invitacion.userId,
        )
      : null;
    const franja = invitacion.timeSlotId
      ? await this.sinNoEncontrado(() =>
          this.franjas.findOne(
            invitacion.timeSlotId as string,
            invitacion.distributorId,
          ),
        )
      : null;
    const cotizacion = await this.cotizar(invitacion, garrafas, ahora);
    return { garrafas, direccion, franja, cotizacion };
  }

  /**
   * Cotiza con el mismo caso de uso que el alta y `POST /orders/quote`, como
   * el cliente que recibió la invitación, con su dirección y su medio de pago.
   * Lo que el alta rechazaría (vencida, producto dado de baja, distribuidora
   * suspendida, sin stock, fuera de cobertura) no es un error de la
   * invitación: se muestra sin cotizar.
   */
  private async cotizar(
    invitacion: RepurchaseInvitation,
    garrafas: Map<string, GasCylinder>,
    ahora: Date,
  ): Promise<QuoteResponseDto | null> {
    if (
      invitacion.status !== RepurchaseInvitationStatus.PENDING ||
      invitacion.expiresAt.getTime() <= ahora.getTime() ||
      !invitacion.addressId ||
      invitacion.suggestedItems.some(
        (i) => !garrafas.get(i.gasCylinderId)?.isActive,
      ) ||
      !(await this.distribuidoraActiva(invitacion.distributorId))
    ) {
      return null;
    }
    const dto = new QuoteOrderDto();
    dto.addressId = invitacion.addressId;
    dto.paymentMethod = medioVigenteDeLaSugerencia(invitacion.paymentMethod);
    dto.items = invitacion.suggestedItems.map((i) => ({
      gasCylinderId: i.gasCylinderId,
      quantity: i.quantity,
      unitPrice: 0,
    }));
    try {
      return await this.cotizador.execute(dto, invitacion.distributorId, {
        userId: invitacion.userId,
        role: RoleType.CUSTOMER,
      });
    } catch (error) {
      const status = errorStatus(error);
      const esRechazo =
        error instanceof DomainError ||
        (error instanceof HttpException && (status ?? 500) < 500);
      if (!esRechazo) {
        this.logger.warn(
          `No se pudo cotizar la invitación ${invitacion.invitationId}: ${errorMessage(error)} (status ${status ?? 'n/d'})`,
        );
      }
      return null;
    }
  }

  private async distribuidoraActiva(distributorId: string): Promise<boolean> {
    const distribuidora = await this.sinNoEncontrado(() =>
      this.distribuidoras.findOne(distributorId),
    );
    return distribuidora?.status === DistributorStatus.ACTIVE;
  }

  private async sinNoEncontrado<T>(
    buscar: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await buscar();
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }
}
