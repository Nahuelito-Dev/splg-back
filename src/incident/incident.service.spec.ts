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
    orders.findById.mockResolvedValue({ orderId: 'o1', distributorId: 'd1' });
    const i = await service.create(
      { orderId: 'o1', type: IncidentType.NO_SHOW, description: 'No estaba' },
      'chofer-1',
      null,
      false,
    );
    expect(i).toMatchObject({
      distributorId: 'd1',
      reportedBy: 'chofer-1',
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
    orders.findById.mockResolvedValue({ orderId: 'o1', distributorId: 'd2' });
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
      orderId: 'o1',
      distributorId: 'd1',
      deliveryId: 'otro',
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
    incidents.findOne.mockResolvedValue({ incidentId: 'i1' });
    const i = await service.resolve('i1', { resolutionNote: 'Listo' }, 'd1');
    expect(i.status).toBe(IncidentStatus.RESOLVED);
    expect(i.resolutionNote).toBe('Listo');
    expect(i.resolvedAt).toBeInstanceOf(Date);
  });

  it('un pedido inexistente y uno ajeno dan el mismo 404 al listar', async () => {
    orders.findById.mockResolvedValueOnce(null);
    await expect(service.findByOrder('o9', 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    orders.findById.mockResolvedValueOnce({
      orderId: 'o1',
      distributorId: 'd2',
    });
    await expect(service.findByOrder('o1', 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /**
   * Comportamiento end-to-end (no metadata de decoradores): un repo falso que
   * FILTRA de verdad por el `where` que le manda el servicio, como haría
   * Postgres. Demuestra el aislamiento completo: crear con una distribuidora,
   * intentar resolver con otra (404) y con la propia (200), sin adivinar la
   * respuesta de antemano.
   */
  describe('aislamiento real entre distribuidoras', () => {
    it('un admin de otra distribuidora no resuelve una incidencia ajena (404); el dueño sí puede', async () => {
      const base: Incident[] = [];
      const incidentsFalso = {
        create: jest.fn((d: Partial<Incident>) => d as Incident),
        save: jest.fn((i: Incident) => {
          const guardada = {
            ...i,
            incidentId: i.incidentId ?? 'incidencia-de-distribuidora-a',
          } as Incident;
          const indice = base.findIndex(
            (b) => b.incidentId === guardada.incidentId,
          );
          if (indice >= 0) base[indice] = guardada;
          else base.push(guardada);
          return Promise.resolve(guardada);
        }),
        find: jest.fn(),
        findOne: jest.fn(
          ({
            where,
          }: {
            where: { incidentId: string; distributorId?: string };
          }) =>
            Promise.resolve(
              base.find(
                (i) =>
                  i.incidentId === where.incidentId &&
                  (where.distributorId === undefined ||
                    i.distributorId === where.distributorId),
              ) ?? null,
            ),
        ),
      };
      const ordersFalso = {
        findById: jest.fn().mockResolvedValue({
          orderId: 'o1',
          distributorId: 'distribuidora-a',
        }),
        assertAsignadoAlChofer: jest.fn(),
        assertDeLaDistribuidora: jest.fn(),
      };
      const servicioLocal = new IncidentService(
        incidentsFalso as unknown as Repository<Incident>,
        ordersFalso as unknown as OrderService,
      );

      // Nace de un pedido de "distribuidora-a".
      await servicioLocal.create(
        { orderId: 'o1', type: IncidentType.OTHER, description: 'fuga' },
        'chofer-a',
        'distribuidora-a',
        false,
      );

      // Un admin de "distribuidora-b" (su distributorId sale de SU perfil,
      // nunca del body ni de la URL) intenta resolverla: Postgres no la
      // devuelve, porque el WHERE de `findOne` la acota a SU distribuidora.
      await expect(
        servicioLocal.resolve(
          'incidencia-de-distribuidora-a',
          { resolutionNote: 'no debería aplicar' },
          'distribuidora-b',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Control: el admin DUEÑO de esa distribuidora sí puede resolverla.
      await expect(
        servicioLocal.resolve(
          'incidencia-de-distribuidora-a',
          { resolutionNote: 'todo bien' },
          'distribuidora-a',
        ),
      ).resolves.toMatchObject({ status: IncidentStatus.RESOLVED });
    });
  });
});
