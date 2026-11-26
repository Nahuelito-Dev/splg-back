import { Injectable, NotFoundException } from '@nestjs/common';
import { GasCylinderService } from '../gascylinder/gascylinder.service';
import { PaymentMethod } from '../order/entities/order.entity';
import { TimeSlotService } from '../time-slot/time-slot.service';
import { UserAddressService } from '../user-address/user-address.service';
import { HabitosDeCompra } from './domain/habitos-de-compra';
import { SuggestedItem } from './entities/repurchase-invitation.entity';

/** El pedido precargado de una invitación. */
export interface Sugerencia {
  items: SuggestedItem[];
  addressId: string;
  timeSlotId: string | null;
  /** Comienzo (`HH:MM`) de su franja habitual, si la tiene y sigue activa. */
  timeSlotStart: string | null;
  paymentMethod: PaymentMethod;
}

export type ResultadoDeSugerencia =
  | { ok: true; sugerencia: Sugerencia }
  | { ok: false; reason: 'no_stock' | 'no_address' };

/**
 * Arma el pedido que se le ofrece al cliente a partir de lo que suele pedir,
 * contra el catálogo de hoy: un producto dado de baja o sin stock suficiente se
 * deja afuera, y si no queda ninguno no hay qué ofrecer. La dirección tiene que
 * seguir existiendo; la franja, estar activa.
 */
@Injectable()
export class RepurchaseSuggestionService {
  constructor(
    private readonly catalogo: GasCylinderService,
    private readonly franjas: TimeSlotService,
    private readonly direcciones: UserAddressService,
  ) {}

  async armar(
    distributorId: string,
    userId: string,
    habitos: HabitosDeCompra,
  ): Promise<ResultadoDeSugerencia> {
    const direccion = await this.direcciones.buscarDelUsuario(
      habitos.addressId,
      userId,
    );
    if (!direccion) return { ok: false, reason: 'no_address' };

    const items: SuggestedItem[] = [];
    for (const item of habitos.items) {
      const garrafa = await this.sinNoEncontrado(() =>
        this.catalogo.findOne(item.gasCylinderId, distributorId),
      );
      if (garrafa?.isActive && garrafa.stock >= item.quantity) {
        items.push({ ...item });
      }
    }
    if (items.length === 0) return { ok: false, reason: 'no_stock' };

    const franja = habitos.timeSlotId
      ? await this.sinNoEncontrado(() =>
          this.franjas.findOne(habitos.timeSlotId as string, distributorId),
        )
      : null;
    return {
      ok: true,
      sugerencia: {
        items,
        addressId: direccion.addressId,
        timeSlotId: franja?.isActive ? franja.timeSlotId : null,
        timeSlotStart: franja?.isActive ? franja.startTime : null,
        paymentMethod: habitos.paymentMethod,
      },
    };
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
