import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { IncidentService } from './incident.service';
import {
  Incident,
  IncidentStatus,
  IncidentType,
} from './entities/incident.entity';
import { OrderService } from '../order/order.service';

/**
 * La incidencia la reporta quien dice el token, hereda la distribuidora del
 * pedido y sólo la resuelve un administrador de esa distribuidora.
 */
describe('IncidentService', () => {
  let service: IncidentService;
  let incidents: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let orders: {
    findById: jest.Mock;
    assertAsignadoAlChofer: jest.Mock;
    assertDeLaDistribuidora: jest.Mock;
  };

  beforeEach(() => {
    incidents = {
      create: jest.fn((d: Partial<Incident>) => d),
      save: jest.fn((i: Incident) => Promise.resolve(i)),
      find: jest.fn(),
      findOne: jest.fn(),
    };
    orders = {
      findById: jest.fn(),
      assertAsignadoAlChofer: jest.fn(),
      assertDeLaDistribuidora: jest.fn(),
    };
    service = new IncidentService(
      incidents as unknown as Repository<Incident>,
      orders as unknown as OrderService,
    );
  });

  it('hereda la distribuidora del pedido y nace abierta', async () => {
    orders.findById.mockResolvedValue({ order_id: 'o1', distributor_id: 'd1' });
    const i = await service.create(
      { orderId: 'o1', type: IncidentType.NO_SHOW, description: 'No estaba' },
      'chofer-1',
      null,
      false,
    );
    expect(i).toMatchObject({
      distributor_id: 'd1',
      reported_by: 'chofer-1',
      status: IncidentStatus.OPEN,
    });
  });

  it('un pedido inexistente es 404', async () => {
    orders.findById.mockResolvedValue(null);
    await expect(
      service.create(
        { orderId: 'o9', type: IncidentType.OTHER, description: 'x' },
        'u1',
        null,
        false,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el pedido de otra distribuidora es 404', async () => {
    orders.findById.mockResolvedValue({ order_id: 'o1', distributor_id: 'd2' });
    await expect(
      service.create(
        { orderId: 'o1', type: IncidentType.OTHER, description: 'x' },
        'u1',
        'd1',
        false,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(incidents.save).not.toHaveBeenCalled();
  });

  it('un chofer sólo reporta sobre el pedido que tiene asignado', async () => {
    orders.findById.mockResolvedValue({
      order_id: 'o1',
      distributor_id: 'd1',
      delivery_id: 'otro',
    });
    orders.assertAsignadoAlChofer.mockRejectedValue(new ForbiddenException());
    await expect(
      service.create(
        { orderId: 'o1', type: IncidentType.OTHER, description: 'x' },
        'chofer-1',
        'd1',
        true,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(orders.assertAsignadoAlChofer).toHaveBeenCalledWith(
      'otro',
      'chofer-1',
    );
  });

  it('no se resuelve una incidencia de otra distribuidora', async () => {
    incidents.findOne.mockResolvedValue(null);
    await expect(
      service.resolve('i1', { resolutionNote: 'ok' }, 'd2'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolver deja la nota y la fecha', async () => {
    incidents.findOne.mockResolvedValue({ incident_id: 'i1' });
    const i = await service.resolve('i1', { resolutionNote: 'Listo' }, 'd1');
    expect(i.status).toBe(IncidentStatus.RESOLVED);
    expect(i.resolution_note).toBe('Listo');
    expect(i.resolvedAt).toBeInstanceOf(Date);
  });

  it('un pedido inexistente y uno ajeno dan el mismo 404 al listar', async () => {
    orders.findById.mockResolvedValueOnce(null);
    await expect(service.findByOrder('o9', 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    orders.findById.mockResolvedValueOnce({
      order_id: 'o1',
      distributor_id: 'd2',
    });
    await expect(service.findByOrder('o1', 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
