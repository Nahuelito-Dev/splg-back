import { NotFoundException } from '@nestjs/common';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import {
  RouteBatch,
  RouteBatchStatus,
} from '../order/entities/route-batch.entity';
import { RouteBatchOffer } from '../order/entities/route-batch-offer.entity';
import { RouteBatchStop } from '../order/entities/route-batch-stop.entity';
import { RouteBatchQueryService } from './route-batch-query.service';

const lote = (batchId: string, over: Partial<RouteBatch> = {}): RouteBatch =>
  ({
    batchId,
    distributorId: 'd1',
    status: RouteBatchStatus.OFFERED,
    totalWeightKg: 25,
    deliveryId: null,
    createdAt: new Date('2026-11-01T12:00:00Z'),
    closedAt: null,
    closeReason: null,
    ...over,
  }) as RouteBatch;

const parada = (
  batchId: string,
  orderId: string,
  sequence: number,
  over: Partial<RouteBatchStop> = {},
): RouteBatchStop =>
  ({
    stopId: `s-${orderId}`,
    batchId,
    orderId,
    sequence,
    active: true,
    etaAt: new Date('2026-11-03T11:00:00Z'),
    legDistanceKm: 1.5,
    order: {
      orderId,
      scheduledDate: '2026-11-03',
      status: 'pending',
      paymentMethod: 'cash',
      totalAmount: 15800,
      deliveryPoint: { type: 'Point', coordinates: [-55.93, -27.38] },
      customer: { fullName: 'Cliente Demo' },
      timeSlot: { name: 'Mañana', startTime: '08:00:00', endTime: '12:00:00' },
      address: {
        street: 'Jujuy 571',
        city: 'Posadas',
        floor: null,
        apartment: null,
        formattedAddress: null,
      },
      items: [
        { quantity: 2, gasCylinder: { type: 'Garrafa 10kg', weight: '10.00' } },
      ],
    },
    ...over,
  }) as unknown as RouteBatchStop;

const oferta = (
  batchId: string,
  deliveryId: string,
  status: ProposalStatus,
  minutos: number,
): RouteBatchOffer =>
  ({
    offerId: `o-${deliveryId}-${batchId}`,
    batchId,
    deliveryId,
    status,
    expiresAt: new Date(Date.UTC(2026, 10, 1, 12, minutos)),
    respondedAt: status === ProposalStatus.PENDING ? null : new Date(),
  }) as RouteBatchOffer;

describe('RouteBatchQueryService', () => {
  let batches: {
    findAndCount: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let stops: { find: jest.Mock };
  let offers: { find: jest.Mock; findAndCount: jest.Mock; findOne: jest.Mock };
  let deliveries: { buscarPorIdOUsuario: jest.Mock };
  let service: RouteBatchQueryService;

  beforeEach(() => {
    batches = {
      findAndCount: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      createQueryBuilder: jest.fn(() => {
        const q = {
          select: () => q,
          addSelect: () => q,
          where: () => q,
          groupBy: () => q,
          getRawMany: () =>
            Promise.resolve([
              { status: 'offered', n: '2' },
              { status: 'assigned', n: '1' },
            ]),
        };
        return q;
      }),
    };
    stops = { find: jest.fn().mockResolvedValue([]) };
    offers = {
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn(),
      findOne: jest.fn(),
    };
    deliveries = {
      buscarPorIdOUsuario: jest.fn((id: string) =>
        Promise.resolve(
          id === 'u1' || id === 'dl1'
            ? {
                deliveryId: 'dl1',
                userId: 'u1',
                user: { fullName: 'Chofer Uno' },
              }
            : null,
        ),
      ),
    };
    service = new RouteBatchQueryService(
      batches as never,
      stops as never,
      offers as never,
      deliveries as never,
    );
  });

  it('lista los lotes de la distribuidora con sus paradas en orden, el chofer contactado y el conteo por estado', async () => {
    batches.findAndCount.mockResolvedValue([[lote('b1')], 1]);
    stops.find.mockResolvedValue([
      parada('b1', 'p2', 2),
      parada('b1', 'p1', 1),
    ]);
    offers.find.mockResolvedValue([
      oferta('b1', 'dl1', ProposalStatus.PENDING, 1),
    ]);

    const page = await service.listar('d1', {
      status: RouteBatchStatus.OFFERED,
      limit: 10,
      offset: 0,
    });

    expect(batches.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { distributorId: 'd1', status: RouteBatchStatus.OFFERED },
      }),
    );
    expect(page.total).toBe(1);
    expect(page.counts).toMatchObject({
      forming: 0,
      offered: 2,
      assigned: 1,
      dissolved: 0,
    });
    const [dto] = page.data;
    expect(dto.stops.map((s) => s.orderId)).toEqual(['p1', 'p2']);
    expect(dto.stops[0]).toMatchObject({
      weightKg: 20,
      customerName: 'Cliente Demo',
      slot: { name: 'Mañana' },
      address: { street: 'Jujuy 571', latitude: -27.38, longitude: -55.93 },
      items: [{ name: 'Garrafa 10kg', quantity: 2 }],
    });
    expect(dto.currentOffer).toMatchObject({
      deliveryId: 'dl1',
      driverName: 'Chofer Uno',
      status: ProposalStatus.PENDING,
    });
    expect(dto.driver).toBeNull();
  });

  it('un lote asignado muestra su chofer y todas las ofertas que hubo, en orden', async () => {
    batches.findAndCount.mockResolvedValue([
      [lote('b1', { status: RouteBatchStatus.ASSIGNED, deliveryId: 'dl1' })],
      1,
    ]);
    offers.find.mockResolvedValue([
      oferta('b1', 'dl1', ProposalStatus.ACCEPTED, 5),
      oferta('b1', 'dl1', ProposalStatus.REJECTED, 1),
    ]);

    const [dto] = (await service.listar('d1', { limit: 10, offset: 0 })).data;

    expect(dto.driver).toEqual({
      deliveryId: 'dl1',
      userId: 'u1',
      name: 'Chofer Uno',
    });
    expect(dto.offers.map((o) => o.status)).toEqual([
      ProposalStatus.REJECTED,
      ProposalStatus.ACCEPTED,
    ]);
    expect(dto.currentOffer).toBeNull();
  });

  it('el detalle de un lote de otra distribuidora es un 404', async () => {
    batches.findOne.mockResolvedValue(null);

    await expect(service.detalle('otra', 'b1')).rejects.toThrow(
      NotFoundException,
    );
    expect(batches.findOne).toHaveBeenCalledWith({
      where: { batchId: 'b1', distributorId: 'otra' },
    });
  });

  it('una lista vacía no consulta paradas ni ofertas', async () => {
    batches.findAndCount.mockResolvedValue([[], 0]);

    expect((await service.listar('d1', { limit: 10, offset: 0 })).data).toEqual(
      [],
    );
    expect(stops.find).not.toHaveBeenCalled();
  });

  describe('lo que ve el chofer', () => {
    const preparar = (
      ofertas: RouteBatchOffer[],
      lotes: RouteBatch[],
      paradas: RouteBatchStop[],
    ) => {
      offers.find.mockResolvedValue(ofertas);
      batches.find.mockResolvedValue(lotes);
      stops.find.mockResolvedValue(paradas);
    };

    it('sólo el lote que espera su respuesta y los que le asignaron, el pendiente primero', async () => {
      preparar(
        [
          oferta('b-asignado', 'dl1', ProposalStatus.ACCEPTED, 30),
          oferta('b-pendiente', 'dl1', ProposalStatus.PENDING, 10),
        ],
        [
          lote('b-asignado', {
            status: RouteBatchStatus.ASSIGNED,
            deliveryId: 'dl1',
          }),
          lote('b-pendiente'),
        ],
        [parada('b-pendiente', 'p1', 1), parada('b-asignado', 'p2', 1)],
      );

      const r = await service.delChofer('u1', 10, 0);

      expect(r.total).toBe(2);
      expect(r.data.map((d) => d.batchId)).toEqual([
        'b-pendiente',
        'b-asignado',
      ]);
    });

    it('no lista los lotes que rechazó, dejó vencer o se deshicieron: llevan datos de clientes que ya no son suyos', async () => {
      preparar(
        [
          oferta('b-rechazado', 'dl1', ProposalStatus.REJECTED, 30),
          oferta('b-vencido', 'dl1', ProposalStatus.EXPIRED, 20),
          oferta('b-deshecho', 'dl1', ProposalStatus.PENDING, 10),
          oferta('b-otro-chofer', 'dl1', ProposalStatus.ACCEPTED, 5),
        ],
        [
          lote('b-rechazado'),
          lote('b-vencido', { status: RouteBatchStatus.DISSOLVED }),
          lote('b-deshecho', { status: RouteBatchStatus.DISSOLVED }),
          // La oferta fue suya pero el lote lo tiene otro chofer.
          lote('b-otro-chofer', {
            status: RouteBatchStatus.ASSIGNED,
            deliveryId: 'dl9',
          }),
        ],
        [parada('b-rechazado', 'p1', 1)],
      );

      const r = await service.delChofer('u1', 10, 0);

      expect(r).toEqual({ data: [], total: 0 });
      await expect(service.unoDelChofer('u1', 'b-rechazado')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.unoDelChofer('u1', 'b-otro-chofer')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('de un lote visible sólo van las paradas vivas', async () => {
      preparar(
        [oferta('b1', 'dl1', ProposalStatus.PENDING, 10)],
        [lote('b1')],
        [parada('b1', 'p1', 1), parada('b1', 'p2', 2, { active: false })],
      );

      const dto = await service.unoDelChofer('u1', 'b1');

      expect(dto.stops.map((s) => s.orderId)).toEqual(['p1']);
      expect(dto.stopCount).toBe(1);
      expect(dto.offer?.status).toBe(ProposalStatus.PENDING);
    });

    it('quien no es chofer no tiene lotes (404)', async () => {
      await expect(service.delChofer('admin', 10, 0)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('porLote arma el mismo detalle que el listado', async () => {
    const dto = await service.porLote(lote('b1'));
    expect(dto.batchId).toBe('b1');
  });
});
