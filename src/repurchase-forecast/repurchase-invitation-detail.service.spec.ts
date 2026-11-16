import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RoleType } from '../common/constants/role-type.enum';
import { DistributorService } from '../distributor/distributor.service';
import { DistributorStatus } from '../distributor/entities/distributor.entity';
import { InsufficientStockError } from '../gascylinder/domain/errors/insufficient-stock.error';
import { QuoteOrderUseCase } from '../order/application/quote-order.use-case';
import { PaymentMethod } from '../order/entities/order.entity';
import { GasCylinderService } from '../gascylinder/gascylinder.service';
import { TimeSlotService } from '../time-slot/time-slot.service';
import { UserAddressService } from '../user-address/user-address.service';
import {
  RepurchaseInvitation,
  RepurchaseInvitationStatus,
} from './entities/repurchase-invitation.entity';
import { RepurchaseInvitationDetailService } from './repurchase-invitation-detail.service';

const invitacion = (
  parcial: Partial<RepurchaseInvitation> = {},
): RepurchaseInvitation =>
  ({
    distributorId: 'd1',
    userId: 'u1',
    addressId: 'a1',
    timeSlotId: 't1',
    status: RepurchaseInvitationStatus.PENDING,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    invitationId: 'i1',
    paymentMethod: PaymentMethod.TRANSFER,
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
  let cotizador: { execute: jest.Mock };
  let distribuidoras: { findOne: jest.Mock };
  let service: RepurchaseInvitationDetailService;

  beforeEach(() => {
    catalogo = {
      findOne: jest
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve({ gasCylinderId: id, type: id, isActive: true }),
        ),
    };
    franjas = { findOne: jest.fn().mockResolvedValue({ timeSlotId: 't1' }) };
    direcciones = {
      buscarDelUsuario: jest.fn().mockResolvedValue({ addressId: 'a1' }),
    };
    cotizador = { execute: jest.fn().mockResolvedValue({ total: 15800 }) };
    distribuidoras = {
      findOne: jest
        .fn()
        .mockResolvedValue({ status: DistributorStatus.ACTIVE }),
    };
    service = new RepurchaseInvitationDetailService(
      catalogo as unknown as GasCylinderService,
      franjas as unknown as TimeSlotService,
      direcciones as unknown as UserAddressService,
      cotizador as unknown as QuoteOrderUseCase,
      distribuidoras as unknown as DistributorService,
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

  describe('cotización', () => {
    it('cotiza como el cliente, con la dirección y el medio de pago de la invitación', async () => {
      const d = await service.detallar(invitacion());
      expect(d.cotizacion).toEqual({ total: 15800 });
      expect(cotizador.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          addressId: 'a1',
          paymentMethod: PaymentMethod.TRANSFER,
          items: [
            { gasCylinderId: 'g10', quantity: 1, unitPrice: 0 },
            { gasCylinderId: 'g45', quantity: 1, unitPrice: 0 },
          ],
        }),
        'd1',
        { userId: 'u1', role: RoleType.CUSTOMER },
      );
    });

    it('una invitación que ya no está abierta no se cotiza', async () => {
      const d = await service.detallar(
        invitacion({ status: RepurchaseInvitationStatus.ACCEPTED }),
      );
      expect(d.cotizacion).toBeNull();
      expect(cotizador.execute).not.toHaveBeenCalled();
    });

    it('sin dirección no se cotiza', async () => {
      const d = await service.detallar(invitacion({ addressId: null }));
      expect(d.cotizacion).toBeNull();
      expect(cotizador.execute).not.toHaveBeenCalled();
    });

    it('sin stock (InsufficientStockError) queda sin cotizar', async () => {
      cotizador.execute.mockRejectedValue(new InsufficientStockError('10kg'));
      const d = await service.detallar(invitacion());
      expect(d.cotizacion).toBeNull();
    });

    it('fuera de cobertura (400) queda sin cotizar', async () => {
      cotizador.execute.mockRejectedValue(
        new BadRequestException('La dirección está fuera de cobertura'),
      );
      const d = await service.detallar(invitacion());
      expect(d.cotizacion).toBeNull();
    });

    it('un error inesperado se avisa y queda sin cotizar, sin romper la lectura', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      cotizador.execute.mockRejectedValue(new Error('base caída'));
      const d = await service.detallar(invitacion());
      expect(d.cotizacion).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('base caída'));
      cotizador.execute.mockRejectedValue(
        new InternalServerErrorException('x'),
      );
      await service.detallar(invitacion());
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it('un rechazo de dominio o 4xx no se avisa', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      cotizador.execute.mockRejectedValue(new InsufficientStockError('10kg'));
      await service.detallar(invitacion());
      cotizador.execute.mockRejectedValue(new BadRequestException('x'));
      await service.detallar(invitacion());
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('con un producto dado de baja no se cotiza', async () => {
      catalogo.findOne.mockImplementation((id: string) =>
        Promise.resolve({
          gasCylinderId: id,
          type: id,
          isActive: id !== 'g45',
        }),
      );
      const d = await service.detallar(invitacion());
      expect(d.cotizacion).toBeNull();
      expect(cotizador.execute).not.toHaveBeenCalled();
    });

    it('con un producto que ya no existe no se cotiza', async () => {
      catalogo.findOne.mockRejectedValueOnce(new NotFoundException());
      const d = await service.detallar(invitacion());
      expect(d.cotizacion).toBeNull();
    });

    it('con la distribuidora suspendida no se cotiza', async () => {
      distribuidoras.findOne.mockResolvedValue({
        status: DistributorStatus.SUSPENDED,
      });
      const d = await service.detallar(invitacion());
      expect(d.cotizacion).toBeNull();
      expect(cotizador.execute).not.toHaveBeenCalled();
    });

    it('una invitación pendiente con la vigencia vencida no se cotiza', async () => {
      const ahora = new Date('2026-11-02T12:00:00Z');
      const d = await service.detallar(
        invitacion({ expiresAt: new Date('2026-11-02T11:00:00Z') }),
        ahora,
      );
      expect(d.cotizacion).toBeNull();
      expect(cotizador.execute).not.toHaveBeenCalled();
    });
  });
});
