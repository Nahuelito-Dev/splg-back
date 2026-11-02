import { BadRequestException } from '@nestjs/common';
import { CustomersService } from '../customer/customer.service';
import { Customer } from '../customer/entities/customer.entity';
import { PaymentMethod } from '../order/entities/order.entity';
import { RepurchaseEstimateSource } from './domain/estimacion-de-recompra';
import {
  RepurchaseInvitation,
  RepurchaseInvitationStatus as Estado,
} from './entities/repurchase-invitation.entity';
import { RepurchaseCustomerService } from './repurchase-customer.service';
import { RepurchaseEstimatorService } from './repurchase-estimator.service';
import { RepurchaseInvitationDetailService } from './repurchase-invitation-detail.service';
import { RepurchaseInvitationService } from './repurchase-invitation.service';

const AHORA = new Date('2026-10-31T12:00:00Z');

const invitacion = (
  parcial: Partial<RepurchaseInvitation> = {},
): RepurchaseInvitation =>
  ({
    invitationId: 'i1',
    distributorId: 'd1',
    userId: 'u1',
    status: Estado.PENDING,
    paymentMethod: PaymentMethod.CASH,
    estimateSource: RepurchaseEstimateSource.HISTORY,
    expiresAt: new Date(AHORA.getTime() + 3_600_000),
    ...parcial,
  }) as RepurchaseInvitation;

const DETALLE = {
  garrafas: new Map(),
  direccion: null,
  franja: null,
  cotizacion: null,
};

describe('RepurchaseCustomerService', () => {
  let estimator: { parametros: jest.Mock; estimarCliente: jest.Mock };
  let customers: {
    findOneByUserId: jest.Mock;
    guardarAvisoDeRecompra: jest.Mock;
  };
  let invitaciones: {
    abiertasDe: jest.Mock;
    listarDelCliente: jest.Mock;
    delCliente: jest.Mock;
  };
  let detalle: { detallar: jest.Mock };
  let service: RepurchaseCustomerService;

  beforeEach(() => {
    estimator = {
      parametros: jest.fn().mockResolvedValue({ anticipationDays: 3 }),
      estimarCliente: jest.fn().mockResolvedValue(null),
    };
    customers = {
      findOneByUserId: jest.fn().mockResolvedValue({
        repurchaseNoticeEnabled: true,
        repurchaseNoticeDays: null,
      } as Customer),
      guardarAvisoDeRecompra: jest.fn().mockResolvedValue({}),
    };
    invitaciones = {
      abiertasDe: jest.fn().mockResolvedValue(new Map()),
      listarDelCliente: jest.fn().mockResolvedValue([]),
      delCliente: jest.fn().mockResolvedValue(invitacion()),
    };
    detalle = { detallar: jest.fn().mockResolvedValue(DETALLE) };
    service = new RepurchaseCustomerService(
      estimator as unknown as RepurchaseEstimatorService,
      customers as unknown as CustomersService,
      invitaciones as unknown as RepurchaseInvitationService,
      detalle as unknown as RepurchaseInvitationDetailService,
    );
  });

  describe('miRecompra', () => {
    it('si nunca le compró a la distribuidora explica que no tiene compras', async () => {
      const r = await service.miRecompra('u1', 'd1', AHORA);
      expect(r.estimacion).toBeNull();
      expect(r.reason).toBe('no_purchases');
      expect(r.abierta).toBeNull();
      expect(r.aviso).toEqual({
        enabled: true,
        days: null,
        distributorDays: 3,
      });
    });

    it('devuelve su estimación y su invitación abierta con el pedido precargado', async () => {
      const cliente = { userId: 'u1' };
      estimator.estimarCliente.mockResolvedValue({ cliente, reason: null });
      invitaciones.abiertasDe.mockResolvedValue(
        new Map([['u1', invitacion()]]),
      );

      const r = await service.miRecompra('u1', 'd1', AHORA);
      expect(detalle.detallar).toHaveBeenCalledWith(expect.anything(), AHORA);

      expect(r.estimacion).toBe(cliente);
      expect(r.reason).toBeNull();
      expect(r.abierta?.invitacion.invitationId).toBe('i1');
      expect(r.abierta?.detalle).toBe(DETALLE);
    });

    it('explica por qué no hay estimación', async () => {
      estimator.estimarCliente.mockResolvedValue({
        cliente: null,
        reason: 'stale',
      });
      expect((await service.miRecompra('u1', 'd1', AHORA)).reason).toBe(
        'stale',
      );
    });

    it('una invitación abierta que ya pasó su vigencia no cuenta', async () => {
      invitaciones.abiertasDe.mockResolvedValue(
        new Map([
          ['u1', invitacion({ expiresAt: new Date(AHORA.getTime() - 1) })],
        ]),
      );
      expect((await service.miRecompra('u1', 'd1', AHORA)).abierta).toBeNull();
    });
  });

  describe('aviso (CU-145)', () => {
    it('sin distribuidora no conoce el valor que rige si no eligió', async () => {
      customers.findOneByUserId.mockResolvedValue({
        repurchaseNoticeEnabled: false,
        repurchaseNoticeDays: 7,
      });
      expect(await service.aviso('u1', null)).toEqual({
        enabled: false,
        days: 7,
        distributorDays: null,
      });
      expect(estimator.parametros).not.toHaveBeenCalled();
    });

    it('guarda sólo lo que viene y devuelve la preferencia vigente', async () => {
      await service.actualizarAviso('u1', { days: 5 }, 'd1');
      expect(customers.guardarAvisoDeRecompra).toHaveBeenCalledWith('u1', {
        noticeEnabled: undefined,
        noticeDays: 5,
      });
    });

    it('days null vuelve al valor de la distribuidora', async () => {
      await service.actualizarAviso('u1', { days: null, enabled: false }, null);
      expect(customers.guardarAvisoDeRecompra).toHaveBeenCalledWith('u1', {
        noticeEnabled: false,
        noticeDays: null,
      });
    });

    it('un cuerpo vacío es 400', async () => {
      await expect(service.actualizarAviso('u1', {}, 'd1')).rejects.toThrow(
        BadRequestException,
      );
      expect(customers.guardarAvisoDeRecompra).not.toHaveBeenCalled();
    });
  });

  describe('invitaciones', () => {
    it('lista las abiertas y vigentes por omisión, con el detalle de cada una', async () => {
      invitaciones.listarDelCliente.mockResolvedValue([invitacion()]);
      const r = await service.listar('u1', 'd1', true, AHORA);
      expect(detalle.detallar).toHaveBeenCalledWith(expect.anything(), AHORA);
      expect(r).toHaveLength(1);
      expect(invitaciones.listarDelCliente).toHaveBeenCalledWith('u1', {
        distributorId: 'd1',
        abiertasA: AHORA,
      });
    });

    it('con todas=true incluye las resueltas, y sin distribuidora son las de todas', async () => {
      await service.listar('u1', null, false, AHORA);
      expect(invitaciones.listarDelCliente).toHaveBeenCalledWith('u1', {
        distributorId: undefined,
        abiertasA: undefined,
      });
    });

    it('una sola, del cliente', async () => {
      const r = await service.una('u1', 'i1');
      expect(r.invitacion.invitationId).toBe('i1');
      expect(invitaciones.delCliente).toHaveBeenCalledWith('i1', 'u1');
    });
  });
});
