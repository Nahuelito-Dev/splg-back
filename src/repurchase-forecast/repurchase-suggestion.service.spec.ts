import { NotFoundException } from '@nestjs/common';
import { GasCylinderService } from '../gascylinder/gascylinder.service';
import { PaymentMethod } from '../order/entities/order.entity';
import { TimeSlotService } from '../time-slot/time-slot.service';
import { UserAddressService } from '../user-address/user-address.service';
import { HabitosDeCompra } from './domain/habitos-de-compra';
import { RepurchaseSuggestionService } from './repurchase-suggestion.service';

const habitos = (parcial: Partial<HabitosDeCompra> = {}): HabitosDeCompra => ({
  items: [{ gasCylinderId: 'g10', quantity: 2 }],
  addressId: 'a1',
  timeSlotId: null,
  paymentMethod: PaymentMethod.CASH,
  ...parcial,
});

describe('RepurchaseSuggestionService', () => {
  let catalogo: { findOne: jest.Mock };
  let franjas: { findOne: jest.Mock };
  let direcciones: { buscarDelUsuario: jest.Mock };
  let service: RepurchaseSuggestionService;

  beforeEach(() => {
    catalogo = {
      findOne: jest.fn().mockResolvedValue({ isActive: true, stock: 5 }),
    };
    franjas = {
      findOne: jest
        .fn()
        .mockResolvedValue({ timeSlotId: 't1', isActive: true }),
    };
    direcciones = {
      buscarDelUsuario: jest.fn().mockResolvedValue({ addressId: 'a1' }),
    };
    service = new RepurchaseSuggestionService(
      catalogo as unknown as GasCylinderService,
      franjas as unknown as TimeSlotService,
      direcciones as unknown as UserAddressService,
    );
  });

  it('arma el pedido con lo que suele pedir contra el catálogo de hoy', async () => {
    const r = await service.armar('d1', 'u1', habitos({ timeSlotId: 't1' }));
    expect(r).toEqual({
      ok: true,
      sugerencia: {
        items: [{ gasCylinderId: 'g10', quantity: 2 }],
        addressId: 'a1',
        timeSlotId: 't1',
        paymentMethod: PaymentMethod.CASH,
      },
    });
    expect(catalogo.findOne).toHaveBeenCalledWith('g10', 'd1');
    expect(direcciones.buscarDelUsuario).toHaveBeenCalledWith('a1', 'u1');
  });

  it('sin dirección vigente no hay qué ofrecer', async () => {
    direcciones.buscarDelUsuario.mockResolvedValue(null);
    expect(await service.armar('d1', 'u1', habitos())).toEqual({
      ok: false,
      reason: 'no_address',
    });
  });

  it('deja afuera el producto dado de baja, inexistente o sin stock suficiente', async () => {
    catalogo.findOne
      .mockResolvedValueOnce({ isActive: false, stock: 9 })
      .mockRejectedValueOnce(new NotFoundException())
      .mockResolvedValueOnce({ isActive: true, stock: 1 })
      .mockResolvedValueOnce({ isActive: true, stock: 3 });
    const r = await service.armar(
      'd1',
      'u1',
      habitos({
        items: [
          { gasCylinderId: 'baja', quantity: 1 },
          { gasCylinderId: 'borrado', quantity: 1 },
          { gasCylinderId: 'poco', quantity: 2 },
          { gasCylinderId: 'ok', quantity: 3 },
        ],
      }),
    );
    expect(r.ok && r.sugerencia.items).toEqual([
      { gasCylinderId: 'ok', quantity: 3 },
    ]);
  });

  it('si no queda ningún producto, no ofrece', async () => {
    catalogo.findOne.mockResolvedValue({ isActive: true, stock: 0 });
    expect(await service.armar('d1', 'u1', habitos())).toEqual({
      ok: false,
      reason: 'no_stock',
    });
  });

  it('una franja inactiva o borrada no se sugiere', async () => {
    franjas.findOne.mockResolvedValueOnce({
      timeSlotId: 't1',
      isActive: false,
    });
    const inactiva = await service.armar(
      'd1',
      'u1',
      habitos({ timeSlotId: 't1' }),
    );
    expect(inactiva.ok && inactiva.sugerencia.timeSlotId).toBeNull();

    franjas.findOne.mockRejectedValueOnce(new NotFoundException());
    const borrada = await service.armar(
      'd1',
      'u1',
      habitos({ timeSlotId: 't1' }),
    );
    expect(borrada.ok && borrada.sugerencia.timeSlotId).toBeNull();
  });

  it('un error que no es «no encontrado» se propaga', async () => {
    catalogo.findOne.mockRejectedValue(new Error('base caída'));
    await expect(service.armar('d1', 'u1', habitos())).rejects.toThrow(
      'base caída',
    );
  });
});
