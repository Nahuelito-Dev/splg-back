import { NotFoundException } from '@nestjs/common';
import { GasCylinderService } from '../gascylinder/gascylinder.service';
import { TimeSlotService } from '../time-slot/time-slot.service';
import { UserAddressService } from '../user-address/user-address.service';
import { RepurchaseInvitation } from './entities/repurchase-invitation.entity';
import { RepurchaseInvitationDetailService } from './repurchase-invitation-detail.service';

const invitacion = (
  parcial: Partial<RepurchaseInvitation> = {},
): RepurchaseInvitation =>
  ({
    distributorId: 'd1',
    userId: 'u1',
    addressId: 'a1',
    timeSlotId: 't1',
    suggestedItems: [
      { gasCylinderId: 'g10', quantity: 1 },
      { gasCylinderId: 'g45', quantity: 1 },
    ],
    ...parcial,
  }) as RepurchaseInvitation;

describe('RepurchaseInvitationDetailService', () => {
  let catalogo: { findOne: jest.Mock };
  let franjas: { findOne: jest.Mock };
  let direcciones: { buscarDelUsuario: jest.Mock };
  let service: RepurchaseInvitationDetailService;

  beforeEach(() => {
    catalogo = {
      findOne: jest
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve({ gasCylinderId: id, type: id }),
        ),
    };
    franjas = { findOne: jest.fn().mockResolvedValue({ timeSlotId: 't1' }) };
    direcciones = {
      buscarDelUsuario: jest.fn().mockResolvedValue({ addressId: 'a1' }),
    };
    service = new RepurchaseInvitationDetailService(
      catalogo as unknown as GasCylinderService,
      franjas as unknown as TimeSlotService,
      direcciones as unknown as UserAddressService,
    );
  });

  it('junta el catálogo, la dirección y la franja de hoy', async () => {
    const d = await service.detallar(invitacion());
    expect([...d.garrafas.keys()]).toEqual(['g10', 'g45']);
    expect(d.direccion).toEqual({ addressId: 'a1' });
    expect(d.franja).toEqual({ timeSlotId: 't1' });
    expect(catalogo.findOne).toHaveBeenCalledWith('g10', 'd1');
    expect(direcciones.buscarDelUsuario).toHaveBeenCalledWith('a1', 'u1');
    expect(franjas.findOne).toHaveBeenCalledWith('t1', 'd1');
  });

  it('lo que ya no existe queda en null o fuera del mapa', async () => {
    catalogo.findOne.mockRejectedValueOnce(new NotFoundException());
    franjas.findOne.mockRejectedValue(new NotFoundException());
    const d = await service.detallar(invitacion());
    expect([...d.garrafas.keys()]).toEqual(['g45']);
    expect(d.franja).toBeNull();
  });

  it('sin dirección ni franja no las busca', async () => {
    const d = await service.detallar(
      invitacion({ addressId: null, timeSlotId: null }),
    );
    expect(d.direccion).toBeNull();
    expect(d.franja).toBeNull();
    expect(direcciones.buscarDelUsuario).not.toHaveBeenCalled();
    expect(franjas.findOne).not.toHaveBeenCalled();
  });

  it('un error que no es «no encontrado» se propaga', async () => {
    catalogo.findOne.mockRejectedValue(new Error('base caída'));
    await expect(service.detallar(invitacion())).rejects.toThrow('base caída');
  });
});
