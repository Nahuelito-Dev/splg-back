import { Injectable, NotFoundException } from '@nestjs/common';
import { GasCylinderService } from '../gascylinder/gascylinder.service';
import { GasCylinder } from '../gascylinder/entities/gascylinder.entity';
import { TimeSlotService } from '../time-slot/time-slot.service';
import { TimeSlot } from '../time-slot/entities/time-slot.entity';
import { UserAddressService } from '../user-address/user-address.service';
import { UserAddress } from '../user-address/entities/user-address.entity';
import { RepurchaseInvitation } from './entities/repurchase-invitation.entity';

/** Lo que una invitación necesita para mostrarse: el catálogo, la dirección y la franja de hoy. */
export interface DetalleDeInvitacion {
  garrafas: Map<string, GasCylinder>;
  direccion: UserAddress | null;
  franja: TimeSlot | null;
}

/**
 * Junta lo que la invitación sólo guarda por id (nombres y precios de hoy, la
 * dirección y la franja) para que la app muestre el pedido precargado.
 */
@Injectable()
export class RepurchaseInvitationDetailService {
  constructor(
    private readonly catalogo: GasCylinderService,
    private readonly franjas: TimeSlotService,
    private readonly direcciones: UserAddressService,
  ) {}

  async detallar(
    invitacion: RepurchaseInvitation,
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
    return { garrafas, direccion, franja };
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
