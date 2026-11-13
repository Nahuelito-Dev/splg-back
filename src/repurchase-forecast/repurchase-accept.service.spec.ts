import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Order, PaymentMethod } from '../order/entities/order.entity';
import { OrderLookupService } from '../order/lookup/order-lookup.service';
import { OrderService } from '../order/order.service';
import { DistributorService } from '../distributor/distributor.service';
import { DistributorStatus } from '../distributor/entities/distributor.entity';
import { RedisService } from '../redis/redis.service';
import { TimeSlotService } from '../time-slot/time-slot.service';
import { UserAddressService } from '../user-address/user-address.service';
import {
  RepurchaseInvitation,
  RepurchaseInvitationStatus as Estado,
} from './entities/repurchase-invitation.entity';
import { RepurchaseAcceptService } from './repurchase-accept.service';
import { RepurchaseInvitationService } from './repurchase-invitation.service';
import { RepurchaseNotifier } from './repurchase-notifier';

const AHORA = new Date('2026-10-31T12:00:00Z');

const invitacion = (
  parcial: Partial<RepurchaseInvitation> = {},
): RepurchaseInvitation =>
  ({
    invitationId: 'i1',
    distributorId: 'd1',
    userId: 'u1',
    addressId: 'a1',
    paymentMethod: PaymentMethod.TRANSFER,
    status: Estado.PENDING,
    suggestedItems: [{ gasCylinderId: 'g10', quantity: 2 }],
    expiresAt: new Date(AHORA.getTime() + 3_600_000),
    createdAt: new Date(AHORA.getTime() - 3_600_000),
    ...parcial,
  }) as RepurchaseInvitation;

describe('RepurchaseAcceptService', () => {
  let invitaciones: {
    delCliente: jest.Mock;
    exigirAbierta: jest.Mock;
    vencerVencidas: jest.Mock;
    cancelar: jest.Mock;
    aceptada: jest.Mock;
    descartar: jest.Mock;
  };
  let orders: { create: jest.Mock; findOne: jest.Mock };
  let distribuidoras: { findOne: jest.Mock };
  let franjas: { findOne: jest.Mock };
  let direcciones: { buscarDelUsuario: jest.Mock };
  let pedidos: { hayPedidoDesde: jest.Mock };
  let notifier: { cerrada: jest.Mock };
  let redis: {
    withLock: jest.Mock;
    get: jest.Mock;
    setex: jest.Mock;
    del: jest.Mock;
  };
  let service: RepurchaseAcceptService;

  beforeEach(() => {
    invitaciones = {
      delCliente: jest.fn().mockResolvedValue(invitacion()),
      exigirAbierta: jest.fn(),
      vencerVencidas: jest.fn().mockResolvedValue([]),
      cancelar: jest.fn().mockResolvedValue(true),
      aceptada: jest
        .fn()
        .mockResolvedValue(invitacion({ status: Estado.ACCEPTED })),
      descartar: jest
        .fn()
        .mockResolvedValue(invitacion({ status: Estado.REJECTED })),
    };
    distribuidoras = {
      findOne: jest
        .fn()
        .mockResolvedValue({ status: DistributorStatus.ACTIVE }),
    };
    franjas = { findOne: jest.fn() };
    direcciones = { buscarDelUsuario: jest.fn().mockResolvedValue({}) };
    orders = {
      create: jest.fn().mockResolvedValue({
        order: { orderId: 'o1' } as Order,
        paymentUrl: 'https://mp',
      }),
      findOne: jest.fn().mockResolvedValue({ orderId: 'o1' } as Order),
    };
    pedidos = { hayPedidoDesde: jest.fn().mockResolvedValue(false) };
    notifier = { cerrada: jest.fn().mockResolvedValue(undefined) };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      withLock: jest
        .fn()
        .mockImplementation(
          async (_k: string, _t: number, fn: () => Promise<unknown>) => ({
            obtenido: true,
            valor: await fn(),
          }),
        ),
    };
    service = new RepurchaseAcceptService(
      invitaciones as unknown as RepurchaseInvitationService,
      orders as unknown as OrderService,
      pedidos as unknown as OrderLookupService,
      notifier as unknown as RepurchaseNotifier,
      redis as unknown as RedisService,
      distribuidoras as unknown as DistributorService,
      franjas as unknown as TimeSlotService,
      direcciones as unknown as UserAddressService,
    );
  });

  it('crea el pedido por el camino normal con lo que se ofreció y registra la aceptación', async () => {
    const r = await service.aceptar('i1', 'u1', {}, AHORA);

    expect(orders.create).toHaveBeenCalledTimes(1);
    const [dto, distributorId] = orders.create.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(distributorId).toBe('d1');
    expect(dto).toMatchObject({
      customerId: 'u1',
      addressId: 'a1',
      paymentMethod: PaymentMethod.TRANSFER,
      items: [{ gasCylinderId: 'g10', quantity: 2, unitPrice: 0 }],
    });
    expect(dto.timeSlotId).toBeUndefined();
    expect(invitaciones.aceptada).toHaveBeenCalledWith('i1', 'o1', AHORA);
    expect(r.order.orderId).toBe('o1');
    expect(r.paymentUrl).toBe('https://mp');
    expect(r.invitation.status).toBe(Estado.ACCEPTED);
    expect(redis.withLock).toHaveBeenCalledWith(
      'repurchase:accept:i1',
      expect.any(Number),
      expect.any(Function),
      expect.any(Number),
    );
  });

  it('el cliente puede cambiar medio de pago, franja, fecha y notas', async () => {
    await service.aceptar(
      'i1',
      'u1',
      {
        paymentMethod: PaymentMethod.MERCADOPAGO,
        timeSlotId: 't1',
        scheduledDate: '2026-11-03',
        notes: 'Portón verde',
      },
      AHORA,
    );
    expect((orders.create.mock.calls as unknown[][])[0][0]).toMatchObject({
      paymentMethod: PaymentMethod.MERCADOPAGO,
      timeSlotId: 't1',
      scheduledDate: '2026-11-03',
      notes: 'Portón verde',
    });
  });

  it('usa la dirección vigente que el cliente eligió al crear el pedido', async () => {
    await service.aceptar('i1', 'u1', { addressId: 'a2' }, AHORA);

    expect(direcciones.buscarDelUsuario).toHaveBeenCalledWith('a2', 'u1');
    expect((orders.create.mock.calls as unknown[][])[0][0]).toMatchObject({
      addressId: 'a2',
    });
  });

  it.each(['ajena', 'inexistente'])(
    'la dirección %s elegida no se revela y responde 404',
    async () => {
      direcciones.buscarDelUsuario.mockResolvedValue(null);

      await expect(
        service.aceptar('i1', 'u1', { addressId: 'a2' }, AHORA),
      ).rejects.toThrow('No encontramos esa dirección entre las tuyas');

      expect(orders.create).not.toHaveBeenCalled();
    },
  );

  it('una dirección borrada lógicamente no se revela y responde 404', async () => {
    direcciones.buscarDelUsuario.mockImplementation((addressId: string) =>
      Promise.resolve(addressId === 'a-borrada' ? null : {}),
    );

    await expect(
      service.aceptar('i1', 'u1', { addressId: 'a-borrada' }, AHORA),
    ).rejects.toThrow('No encontramos esa dirección entre las tuyas');

    expect(orders.create).not.toHaveBeenCalled();
  });

  it.each([{ timeSlotId: 't1' }, { scheduledDate: '2026-11-03' }])(
    'franja y fecha van juntas: %j es 400',
    async (cuerpo) => {
      await expect(service.aceptar('i1', 'u1', cuerpo, AHORA)).rejects.toThrow(
        BadRequestException,
      );
      expect(redis.withLock).not.toHaveBeenCalled();
    },
  );

  it('si el cerrojo no se obtiene, 409 y no crea nada', async () => {
    redis.withLock.mockResolvedValue({ obtenido: false });
    await expect(service.aceptar('i1', 'u1', {}, AHORA)).rejects.toThrow(
      ConflictException,
    );
    expect(orders.create).not.toHaveBeenCalled();
  });

  it('la invitación de otro cliente es 404', async () => {
    invitaciones.delCliente.mockRejectedValue(new NotFoundException());
    await expect(service.aceptar('i1', 'otro', {}, AHORA)).rejects.toThrow(
      NotFoundException,
    );
    expect(orders.create).not.toHaveBeenCalled();
  });

  it('una invitación que ya no está abierta se rechaza sin crear pedido', async () => {
    invitaciones.exigirAbierta.mockImplementation(() => {
      throw new ConflictException('La invitación ya fue aceptada');
    });
    await expect(service.aceptar('i1', 'u1', {}, AHORA)).rejects.toThrow(
      'ya fue aceptada',
    );
    expect(orders.create).not.toHaveBeenCalled();
  });

  it('pasada la vigencia la vence, avisa y responde 409', async () => {
    const vencida = invitacion({ expiresAt: new Date(AHORA.getTime() - 1) });
    const ajena = invitacion({ invitationId: 'i2', userId: 'u2' });
    invitaciones.delCliente.mockResolvedValue(vencida);
    invitaciones.vencerVencidas.mockResolvedValue([vencida, ajena]);

    await expect(service.aceptar('i1', 'u1', {}, AHORA)).rejects.toThrow(
      'La invitación venció',
    );

    expect(invitaciones.vencerVencidas).toHaveBeenCalledWith(AHORA, 'd1');
    // Se avisa de todas las que venció ese barrido, no sólo de la propia.
    expect(notifier.cerrada).toHaveBeenCalledWith(vencida, 'expired');
    expect(notifier.cerrada).toHaveBeenCalledWith(ajena, 'expired');
    expect(orders.create).not.toHaveBeenCalled();
  });

  it('si el cliente compró por su cuenta mientras corría, la cierra sin efecto y responde 409', async () => {
    pedidos.hayPedidoDesde.mockResolvedValue(true);

    await expect(service.aceptar('i1', 'u1', {}, AHORA)).rejects.toThrow(
      'ya hiciste un pedido',
    );

    expect(pedidos.hayPedidoDesde).toHaveBeenCalledWith(
      'd1',
      'u1',
      new Date(AHORA.getTime() - 3_600_000),
    );
    expect(invitaciones.cancelar).toHaveBeenCalledWith('i1', AHORA);
    expect(notifier.cerrada).toHaveBeenCalledWith(
      expect.anything(),
      'cancelled',
    );
    expect(orders.create).not.toHaveBeenCalled();
  });

  it('si la dirección ya no existe no se puede aceptar', async () => {
    invitaciones.delCliente.mockResolvedValue(invitacion({ addressId: null }));
    await expect(service.aceptar('i1', 'u1', {}, AHORA)).rejects.toThrow(
      'La dirección de la invitación ya no existe',
    );
    expect(orders.create).not.toHaveBeenCalled();
  });

  it('con dirección propia, acepta aunque ya no exista la de la invitación', async () => {
    invitaciones.delCliente.mockResolvedValue(invitacion({ addressId: null }));

    await service.aceptar('i1', 'u1', { addressId: 'a2' }, AHORA);

    expect(direcciones.buscarDelUsuario).toHaveBeenCalledWith('a2', 'u1');
    expect((orders.create.mock.calls as unknown[][])[0][0]).toMatchObject({
      addressId: 'a2',
    });
  });

  it('si el pedido falla (sin stock, fuera de cobertura) la invitación sigue abierta', async () => {
    orders.create.mockRejectedValue(new BadRequestException('Sin stock'));
    await expect(service.aceptar('i1', 'u1', {}, AHORA)).rejects.toThrow(
      'Sin stock',
    );
    expect(invitaciones.aceptada).not.toHaveBeenCalled();
  });

  it('en una distribuidora suspendida no se puede aceptar', async () => {
    distribuidoras.findOne.mockResolvedValue({
      status: DistributorStatus.SUSPENDED,
    });
    await expect(service.aceptar('i1', 'u1', {}, AHORA)).rejects.toThrow(
      'La distribuidora no está disponible',
    );
    expect(orders.create).not.toHaveBeenCalled();
  });

  describe('franja habitual', () => {
    // AHORA son las 09:00 en Argentina.
    const MEDIODIA = AHORA;
    const franja = (parcial: object = {}) => ({
      timeSlotId: 't1',
      isActive: true,
      endTime: '20:00:00',
      ...parcial,
    });

    beforeEach(() => {
      invitaciones.delCliente.mockResolvedValue(
        invitacion({ timeSlotId: 't1' }),
      );
    });

    it('sin franja en el cuerpo usa la de la invitación, hoy si todavía no terminó', async () => {
      franjas.findOne.mockResolvedValue(franja());
      await service.aceptar('i1', 'u1', {}, MEDIODIA);
      expect((orders.create.mock.calls as unknown[][])[0][0]).toMatchObject({
        timeSlotId: 't1',
        scheduledDate: '2026-10-31',
      });
      expect(franjas.findOne).toHaveBeenCalledWith('t1', 'd1');
    });

    it('si la franja de hoy ya terminó, agenda para mañana', async () => {
      franjas.findOne.mockResolvedValue(franja({ endTime: '08:30:00' }));
      await service.aceptar('i1', 'u1', {}, MEDIODIA);
      expect((orders.create.mock.calls as unknown[][])[0][0]).toMatchObject({
        scheduledDate: '2026-11-01',
      });
    });

    it.each([
      [
        'inactiva',
        () => franjas.findOne.mockResolvedValue(franja({ isActive: false })),
      ],
      [
        'borrada',
        () => franjas.findOne.mockRejectedValue(new NotFoundException()),
      ],
    ])(
      'si la franja está %s, la entrega es inmediata',
      async (_n, preparar) => {
        preparar();
        await service.aceptar('i1', 'u1', {}, MEDIODIA);
        const dto = (orders.create.mock.calls as unknown[][])[0][0] as Record<
          string,
          unknown
        >;
        expect(dto.timeSlotId).toBeUndefined();
        expect(dto.scheduledDate).toBeUndefined();
      },
    );

    it('lo que el cliente manda en el cuerpo manda sobre la franja habitual', async () => {
      await service.aceptar(
        'i1',
        'u1',
        { timeSlotId: 't9', scheduledDate: '2026-11-05' },
        MEDIODIA,
      );
      expect(franjas.findOne).not.toHaveBeenCalled();
      expect((orders.create.mock.calls as unknown[][])[0][0]).toMatchObject({
        timeSlotId: 't9',
        scheduledDate: '2026-11-05',
      });
    });

    it('un error que no es «no encontrado» al buscar la franja se propaga', async () => {
      franjas.findOne.mockRejectedValue(new Error('base caída'));
      await expect(service.aceptar('i1', 'u1', {}, MEDIODIA)).rejects.toThrow(
        'base caída',
      );
    });
  });

  describe('si falla el registro de la aceptación después de crear el pedido', () => {
    it('guarda el pedido creado antes de registrar y lo olvida al registrar bien', async () => {
      await service.aceptar('i1', 'u1', {}, AHORA);
      expect(redis.setex).toHaveBeenCalledWith(
        'repurchase:accepted-order:i1',
        expect.any(Number),
        'o1',
      );
      expect(redis.del).toHaveBeenCalledWith('repurchase:accepted-order:i1');
    });

    it('el reintento reconoce el pedido propio: no lo toma por una compra por su cuenta y devuelve la invitación aceptada', async () => {
      invitaciones.aceptada.mockRejectedValueOnce(new Error('base caída'));
      await expect(service.aceptar('i1', 'u1', {}, AHORA)).rejects.toThrow(
        'base caída',
      );

      // El pedido ya existe: un chequeo de «pedido propio» lo vería como ajeno.
      pedidos.hayPedidoDesde.mockResolvedValue(true);
      redis.get.mockResolvedValue('o1');
      const r = await service.aceptar('i1', 'u1', {}, AHORA);

      expect(orders.create).toHaveBeenCalledTimes(1);
      expect(invitaciones.cancelar).not.toHaveBeenCalled();
      expect(orders.findOne).toHaveBeenCalledWith('o1');
      expect(r.order.orderId).toBe('o1');
      expect(r.invitation.status).toBe(Estado.ACCEPTED);
    });

    it('si la invitación ya figura aceptada, un marcador viejo no la acepta dos veces', async () => {
      invitaciones.delCliente.mockResolvedValue(
        invitacion({ status: Estado.ACCEPTED }),
      );
      invitaciones.exigirAbierta.mockImplementation(() => {
        throw new ConflictException('ya fue aceptada');
      });
      redis.get.mockResolvedValue('o1');
      await expect(service.aceptar('i1', 'u1', {}, AHORA)).rejects.toThrow(
        'ya fue aceptada',
      );
      expect(orders.findOne).not.toHaveBeenCalled();
    });
  });

  describe('descartar', () => {
    it('toma el mismo cerrojo que aceptar', async () => {
      const r = await service.descartar('i1', 'u1', AHORA);
      expect(redis.withLock).toHaveBeenCalledWith(
        'repurchase:accept:i1',
        expect.any(Number),
        expect.any(Function),
        expect.any(Number),
      );
      expect(invitaciones.descartar).toHaveBeenCalledWith('i1', 'u1', AHORA);
      expect(r.status).toBe(Estado.REJECTED);
    });

    it('si el cerrojo lo tiene una aceptación en curso, no descarta: 409', async () => {
      redis.withLock.mockResolvedValue({ obtenido: false });
      await expect(service.descartar('i1', 'u1', AHORA)).rejects.toThrow(
        ConflictException,
      );
      expect(invitaciones.descartar).not.toHaveBeenCalled();
    });

    it('carrera: aceptar y descartar a la vez se serializan, gana el primero y el segundo recibe 409', async () => {
      // Un cerrojo de verdad en memoria: una función a la vez por clave.
      let cola: Promise<unknown> = Promise.resolve();
      redis.withLock.mockImplementation(
        (_k: string, _t: number, fn: () => Promise<unknown>) => {
          const turno = cola.then(fn);
          cola = turno.catch(() => undefined);
          return turno.then((valor) => ({ obtenido: true, valor }));
        },
      );
      let estado = Estado.PENDING;
      invitaciones.delCliente.mockImplementation(() =>
        Promise.resolve(invitacion({ status: estado })),
      );
      invitaciones.exigirAbierta.mockImplementation((i: { status: Estado }) => {
        if (i.status !== Estado.PENDING)
          throw new ConflictException('ya no está abierta');
      });
      invitaciones.aceptada.mockImplementation(() => {
        estado = Estado.ACCEPTED;
        return Promise.resolve(invitacion({ status: Estado.ACCEPTED }));
      });
      invitaciones.descartar.mockImplementation(() => {
        if (estado !== Estado.PENDING)
          throw new ConflictException('ya no está abierta');
        estado = Estado.REJECTED;
        return Promise.resolve(invitacion({ status: Estado.REJECTED }));
      });

      const [aceptar, descartar] = await Promise.allSettled([
        service.aceptar('i1', 'u1', {}, AHORA),
        service.descartar('i1', 'u1', AHORA),
      ]);

      expect([aceptar.status, descartar.status]).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect(estado).toBe(Estado.ACCEPTED);
      expect(orders.create).toHaveBeenCalledTimes(1);
    });
  });
});
