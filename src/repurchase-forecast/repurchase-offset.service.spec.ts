import { Repository } from 'typeorm';
import { RepurchaseOffset } from './entities/repurchase-offset.entity';
import { RepurchaseInvitationService } from './repurchase-invitation.service';
import { RepurchaseOffsetListener } from './repurchase-offset.listener';
import { RepurchaseOffsetService } from './repurchase-offset.service';
import { PedidoEntregadoEvent } from '../order/domain/events/pedido-entregado.event';
import { PaymentMethod } from '../order/entities/order.entity';

describe('RepurchaseOffsetService', () => {
  let repo: { find: jest.Mock; upsert: jest.Mock };
  let invitaciones: { erroresDelCliente: jest.Mock };
  let service: RepurchaseOffsetService;
  const AHORA = new Date('2026-10-31T12:00:00Z');

  beforeEach(() => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue(undefined),
    };
    invitaciones = { erroresDelCliente: jest.fn().mockResolvedValue([]) };
    service = new RepurchaseOffsetService(
      repo as unknown as Repository<RepurchaseOffset>,
      invitaciones as unknown as RepurchaseInvitationService,
    );
  });

  it('deClientes: los ajustes guardados, acotados a la distribuidora', async () => {
    repo.find.mockResolvedValue([{ userId: 'u1', offsetDays: 3 }]);
    const r = await service.deClientes('d1', ['u1', 'u2']);
    expect(r).toEqual(new Map([['u1', 3]]));
    const [consulta] = repo.find.mock.calls[0] as [{ where: object }];
    expect(consulta.where).toMatchObject({ distributorId: 'd1' });
  });

  it('deClientes sin clientes no consulta', async () => {
    expect(await service.deClientes('d1', [])).toEqual(new Map());
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('recalcular guarda el error medio de sus invitaciones medidas', async () => {
    invitaciones.erroresDelCliente.mockResolvedValue([3, 5]);
    expect(await service.recalcular('d1', 'u1', AHORA)).toBe(4);
    expect(invitaciones.erroresDelCliente).toHaveBeenCalledWith('d1', 'u1');
    expect(repo.upsert).toHaveBeenCalledWith(
      {
        distributorId: 'd1',
        userId: 'u1',
        offsetDays: 4,
        sampleSize: 2,
        computedAt: AHORA,
      },
      ['userId', 'distributorId'],
    );
  });

  it('recalcular con un error enorme lo guarda acotado', async () => {
    invitaciones.erroresDelCliente.mockResolvedValue([60, 80]);
    expect(await service.recalcular('d1', 'u1', AHORA)).toBe(15);
  });

  it('recalcular con una sola medida guarda cero', async () => {
    invitaciones.erroresDelCliente.mockResolvedValue([7]);
    expect(await service.recalcular('d1', 'u1', AHORA)).toBe(0);
  });
});

describe('RepurchaseOffsetListener', () => {
  const evento = new PedidoEntregadoEvent(
    'o1',
    'd1',
    null,
    'u1',
    PaymentMethod.CASH,
    100,
    new Date('2026-10-31T12:00:00Z'),
  );

  it('recalcula el ajuste del cliente al entregarse un pedido', async () => {
    const offsets = { recalcular: jest.fn().mockResolvedValue(2) };
    await new RepurchaseOffsetListener(
      offsets as unknown as RepurchaseOffsetService,
    ).handle(evento);
    expect(offsets.recalcular).toHaveBeenCalledWith(
      'd1',
      'u1',
      expect.any(Date),
    );
  });

  it('si falla no bloquea la entrega', async () => {
    const offsets = {
      recalcular: jest.fn().mockRejectedValue(new Error('base caída')),
    };
    await expect(
      new RepurchaseOffsetListener(
        offsets as unknown as RepurchaseOffsetService,
      ).handle(evento),
    ).resolves.toBeUndefined();
  });
});
