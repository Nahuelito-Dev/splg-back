import { PaymentStatus } from '../order/entities/order.entity';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { EVENTO_NOTIFICAR_ADMIN } from '../common/events/notificar-admin.event';
import { IncidentService } from './incident.service';
import {
  Incident,
  IncidentStatus,
  IncidentType,
} from './entities/incident.entity';
import { OrderService } from '../order/order.service';
import { AdminGateway } from '../gateways/admin.gateway';

/**
 * La incidencia la reporta quien dice el token, hereda la distribuidora del
 * pedido y sólo la resuelve un administrador de esa distribuidora.
 */
describe('IncidentService', () => {
  let service: IncidentService;
  let admins: { notifyAdmins: jest.Mock };
  let events: { emit: jest.Mock };
  let incidents: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let orders: {
    findById: jest.Mock;
    assertPedidoPropioDelChofer: jest.Mock;
    assertDeLaDistribuidora: jest.Mock;
  };

  beforeEach(() => {
    incidents = {
      create: jest.fn((d: Partial<Incident>) => d),
      save: jest.fn((i: Incident) => Promise.resolve(i)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn(),
      findOne: jest.fn(),
    };
    orders = {
      findById: jest.fn(),
      assertPedidoPropioDelChofer: jest.fn(),
      assertDeLaDistribuidora: jest.fn(),
    };
    admins = { notifyAdmins: jest.fn() };
    events = { emit: jest.fn() };
    service = new IncidentService(
      incidents as unknown as Repository<Incident>,
      orders as unknown as OrderService,
      admins as unknown as AdminGateway,
      events as unknown as EventEmitter2,
    );
  });

  it('pide el aviso de la bandeja con la incidencia como clave y destino', async () => {
    orders.findById.mockResolvedValue({
      orderId: 'ord-abcdef',
      distributorId: 'd1',
    });
    incidents.save.mockImplementationOnce((i: Incident) =>
      Promise.resolve({ ...i, incidentId: 'inc-1' }),
    );
    await service.create(
      {
        orderId: 'ord-abcdef',
        type: IncidentType.DAMAGED,
        description: 'Rota',
      },
      'chofer-1',
      null,
      false,
    );
    expect(events.emit).toHaveBeenCalledWith(
      EVENTO_NOTIFICAR_ADMIN,
      expect.objectContaining({
        distributorId: 'd1',
        kind: 'incident_created',
        body: 'Pedido #ABCDEF: Producto dañado',
        dedupeKey: 'incident:inc-1',
        link: { entity: 'incident', id: 'inc-1' },
        email: false,
      }),
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

  it('avisa a los admins de la distribuidora del pedido', async () => {
    orders.findById.mockResolvedValue({ orderId: 'o1', distributorId: 'd1' });
    await service.create(
      { orderId: 'o1', type: IncidentType.NO_SHOW, description: 'No estaba' },
      'chofer-1',
      null,
      false,
    );
    expect(admins.notifyAdmins).toHaveBeenCalledWith(
      'incident:created',
      expect.objectContaining({
        orderId: 'o1',
        distributorId: 'd1',
        type: IncidentType.NO_SHOW,
      }),
      'd1',
    );
  });

  it('si el aviso falla, la incidencia igual queda registrada', async () => {
    orders.findById.mockResolvedValue({ orderId: 'o1', distributorId: 'd1' });
    admins.notifyAdmins.mockImplementation(() => {
      throw new Error('socket caído');
    });
    await expect(
      service.create(
        { orderId: 'o1', type: IncidentType.NO_SHOW, description: 'x' },
        'chofer-1',
        null,
        false,
      ),
    ).resolves.toMatchObject({ distributorId: 'd1' });
  });

  describe('tipo cobro impago (sólo por /payment/unpaid)', () => {
    it('POST /incidents no lo acepta', async () => {
      await expect(
        service.create(
          {
            orderId: 'o1',
            type: IncidentType.UNPAID_COLLECTION,
            description: 'x',
          },
          'chofer-1',
          null,
          false,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(incidents.save).not.toHaveBeenCalled();
    });

    it('PATCH no cambia hacia unpaid_collection', async () => {
      incidents.findOne.mockResolvedValue({
        incidentId: 'i1',
        status: IncidentStatus.OPEN,
        type: IncidentType.OTHER,
      });
      await expect(
        service.update('i1', { type: IncidentType.UNPAID_COLLECTION }),
      ).rejects.toThrow(BadRequestException);
      expect(incidents.save).not.toHaveBeenCalled();
    });

    it('PATCH no cambia desde unpaid_collection', async () => {
      incidents.findOne.mockResolvedValue({
        incidentId: 'i1',
        status: IncidentStatus.OPEN,
        type: IncidentType.UNPAID_COLLECTION,
      });
      await expect(
        service.update('i1', { type: IncidentType.OTHER }),
      ).rejects.toThrow(BadRequestException);
      expect(incidents.save).not.toHaveBeenCalled();
    });

    it('PATCH de la descripción de una de cobro impago sí se puede', async () => {
      incidents.findOne.mockResolvedValue({
        incidentId: 'i1',
        status: IncidentStatus.OPEN,
        type: IncidentType.UNPAID_COLLECTION,
        description: 'a',
      });
      await service.update('i1', { description: 'b' });
      expect(incidents.update).toHaveBeenCalled();
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
    orders.assertPedidoPropioDelChofer.mockRejectedValue(
      new NotFoundException(),
    );
    await expect(
      service.create(
        { orderId: 'o1', type: IncidentType.OTHER, description: 'x' },
        'chofer-1',
        'd1',
        true,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(orders.assertPedidoPropioDelChofer).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'o1', deliveryId: 'otro' }),
      'chofer-1',
    );
    expect(incidents.save).not.toHaveBeenCalled();
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
        update: jest.fn(
          (donde: { incidentId: string }, cambios: Partial<Incident>) => {
            const i = base.find((b) => b.incidentId === donde.incidentId);
            if (i) Object.assign(i, cambios);
            return Promise.resolve({ affected: i ? 1 : 0 });
          },
        ),
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
        assertPedidoPropioDelChofer: jest.fn(),
        assertDeLaDistribuidora: jest.fn(),
      };
      const servicioLocal = new IncidentService(
        incidentsFalso as unknown as Repository<Incident>,
        ordersFalso as unknown as OrderService,
        admins as unknown as AdminGateway,
        events as unknown as EventEmitter2,
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

  describe('ficha, edición y descarte', () => {
    const abierta = (over: Partial<Incident> = {}) =>
      ({
        incidentId: 'i1',
        status: IncidentStatus.OPEN,
        description: 'a',
        ...over,
      }) as Incident;

    it('la ficha de otra distribuidora es 404', async () => {
      incidents.findOne.mockResolvedValue(null);
      await expect(service.findDetail('i1', 'otra')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(incidents.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { incidentId: 'i1', distributorId: 'otra' },
        }),
      );
    });

    it('edita la descripción de una incidencia abierta', async () => {
      incidents.findOne.mockResolvedValue(abierta());
      await service.update('i1', { description: 'nueva' }, 'd1');
      expect(incidents.update).toHaveBeenCalledWith(
        { incidentId: 'i1', status: IncidentStatus.OPEN },
        { description: 'nueva' },
      );
    });

    it.each([IncidentStatus.RESOLVED, IncidentStatus.DISCARDED])(
      'una incidencia %s no se edita (409)',
      async (status) => {
        incidents.findOne.mockResolvedValue(abierta({ status }));
        await expect(
          service.update('i1', { description: 'x' }, 'd1'),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(incidents.update).not.toHaveBeenCalled();
      },
    );

    it('descartar una abierta guarda el motivo y la fecha', async () => {
      incidents.findOne.mockResolvedValue(abierta());
      const r = await service.resolve(
        'i1',
        { resolutionNote: 'duplicada', status: IncidentStatus.DISCARDED },
        'd1',
      );
      expect(r).toMatchObject({
        status: IncidentStatus.DISCARDED,
        resolutionNote: 'duplicada',
      });
      expect(r.resolvedAt).toBeInstanceOf(Date);
    });

    it('no se descarta una resuelta ni se toca una descartada (409)', async () => {
      incidents.findOne.mockResolvedValue(
        abierta({ status: IncidentStatus.RESOLVED }),
      );
      await expect(
        service.resolve(
          'i1',
          { resolutionNote: 'x', status: IncidentStatus.DISCARDED },
          'd1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      incidents.findOne.mockResolvedValue(
        abierta({ status: IncidentStatus.DISCARDED }),
      );
      await expect(
        service.resolve('i1', { resolutionNote: 'x' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(incidents.update).not.toHaveBeenCalled();
    });

    it('una incidencia ya resuelta no se sobrescribe (409)', async () => {
      incidents.findOne.mockResolvedValue(
        abierta({ status: IncidentStatus.RESOLVED, resolutionNote: 'orig' }),
      );
      await expect(
        service.resolve('i1', { resolutionNote: 'otra' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(incidents.update).not.toHaveBeenCalled();
    });

    describe('la de cobro impago con el pedido unpaid', () => {
      beforeEach(() => {
        incidents.findOne.mockResolvedValue(
          abierta({ type: IncidentType.UNPAID_COLLECTION, orderId: 'o1' }),
        );
        orders.findById.mockResolvedValue({
          orderId: 'o1',
          paymentStatus: PaymentStatus.UNPAID,
        });
      });

      it.each([IncidentStatus.RESOLVED, IncidentStatus.DISCARDED] as const)(
        'no se cierra como %s por la puerta genérica (409)',
        async (status) => {
          await expect(
            service.resolve('i1', { resolutionNote: 'x', status }, 'd1'),
          ).rejects.toThrow(/resolve-unpaid/);
          expect(incidents.update).not.toHaveBeenCalled();
        },
      );
    });

    it('la de cobro impago se cierra por la genérica si el pedido ya no está unpaid', async () => {
      incidents.findOne.mockResolvedValue(
        abierta({ type: IncidentType.UNPAID_COLLECTION, orderId: 'o1' }),
      );
      orders.findById.mockResolvedValue({
        orderId: 'o1',
        paymentStatus: PaymentStatus.PAID,
      });
      const r = await service.resolve('i1', { resolutionNote: 'ok' }, 'd1');
      expect(r.status).toBe(IncidentStatus.RESOLVED);
    });

    it('si otro la cerró entre la lectura y la escritura, 409 y no pisa la resolución', async () => {
      incidents.findOne.mockResolvedValue(abierta());
      incidents.update.mockResolvedValue({ affected: 0 });
      await expect(
        service.resolve('i1', { resolutionNote: 'x' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(incidents.update).toHaveBeenCalledWith(
        { incidentId: 'i1', status: IncidentStatus.OPEN },
        expect.objectContaining({ status: IncidentStatus.RESOLVED }),
      );
      expect(incidents.save).not.toHaveBeenCalled();
    });

    it('editar tampoco pisa una resolución hecha en paralelo', async () => {
      incidents.findOne.mockResolvedValue(abierta());
      incidents.update.mockResolvedValue({ affected: 0 });
      await expect(
        service.update('i1', { description: 'x' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('sin status resuelve, como siempre', async () => {
      incidents.findOne.mockResolvedValue(abierta());
      const r = await service.resolve('i1', { resolutionNote: 'ok' }, 'd1');
      expect(r.status).toBe(IncidentStatus.RESOLVED);
    });
  });
});
