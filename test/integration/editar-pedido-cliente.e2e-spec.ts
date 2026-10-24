/**
 * Integración (HTTP con el router real, Postgres y Redis efímeros): el CLIENTE
 * dueño edita su pedido (`PATCH /orders/:id`) mientras esté `pending` y sin
 * chofer. Permiso por rol, dueño ajeno (404), 409 con chofer, precio siempre
 * del servidor, reservas de stock ajustadas, anotación en el historial y la
 * carrera contra la aceptación del chofer.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  telefonoDePrueba,
  truncateAllTables,
} from './setup/test-env';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Car } from '../../src/car/entities/car.entity';
import { VehicleAssignment } from '../../src/car/entities/vehicle-assignment.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { OrderItem } from '../../src/order/entities/order-item.entity';
import { OrderStatusHistory } from '../../src/order/entities/order-status-history.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { RedisService } from '../../src/redis/redis.service';
import { TimeSlot } from '../../src/time-slot/entities/time-slot.entity';
import { diaArgentino } from '../../src/common/utils/dias-argentina';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { forzarEstado } from './setup/bypass';

type Headers = Record<string, string>;

describe('Editar el pedido como cliente (HTTP e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let seq = 0;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
  }, 240000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  const http = () => request(env.app.getHttpServer());
  const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function usuario(
    tipo: 'customer' | 'delivery' | 'admin',
    nombre: string,
  ) {
    seq += 1;
    const roles = ds.getRepository(Role);
    const rol =
      (await roles.findOne({ where: { type: tipo } })) ??
      (await roles.save({ type: tipo } as Partial<Role>));
    const email = `${tipo}.${seq}.${randomUUID().slice(0, 6)}@splg.local`;
    const user = await ds.getRepository(User).save({
      email,
      fullName: nombre,
      phoneNumber: telefonoDePrueba(),
      roleId: rol.roleId,
    } as Partial<User>);
    return { user, email };
  }

  const h = (email: string, fuente: string, extra: Headers = {}): Headers => ({
    Authorization: `Bearer ${email}`,
    'X-Client-Source': fuente,
    ...extra,
  });

  async function escenario() {
    seq += 1;
    const dist = await ds.getRepository(Distributor).save({
      name: 'Distribuidora A',
      slug: `dist-${seq}-${randomUUID().slice(0, 4)}`,
      legalName: 'Test SRL',
      taxId: `30-${seq}${Date.now()}`,
      email: `d${seq}${Date.now()}@test.local`,
      phone: '+540000000000',
    } as Partial<Distributor>);
    const cli = await usuario('customer', 'Cliente Uno');
    const cli2 = await usuario('customer', 'Cliente Dos');
    for (const c of [cli, cli2]) {
      await ds.getRepository(Customer).save({
        userId: c.user.userId,
        notificationToken: 'fake',
      } as Partial<Customer>);
    }
    const dir = await ds.getRepository(UserAddress).save({
      userId: cli.user.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>);
    const garrafa = await ds.getRepository(GasCylinder).save({
      type: '10kg',
      price: 1000,
      stock: 50,
      weight: 10,
      isActive: true,
      distributorId: dist.distributorId,
    } as Partial<GasCylinder>);
    const chofer = await usuario('delivery', 'Ana Chofer');
    const del = await ds.getRepository(Delivery).save({
      userId: chofer.user.userId,
      distributorId: dist.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>);
    const auto = await ds.getRepository(Car).save({
      distributorId: dist.distributorId,
      userId: chofer.user.userId,
      carPatent: `T${seq}${randomUUID().slice(0, 4).toUpperCase()}`,
    } as Partial<Car>);
    await ds.getRepository(VehicleAssignment).save({
      distributorId: dist.distributorId,
      carId: auto.carId,
      deliveryId: del.deliveryId,
      assignedAt: new Date(),
    } as Partial<VehicleAssignment>);
    const dX = { 'X-Distributor': dist.slug };
    return {
      dist,
      del,
      dir,
      garrafa,
      cliente: h(cli.email, 'customer-app', dX),
      cliente2: h(cli2.email, 'customer-app', dX),
      chofer: h(chofer.email, 'delivery-app'),
      cliUserId: cli.user.userId,
    };
  }
  type E = Awaited<ReturnType<typeof escenario>>;

  /** El alta real por la API: reserva stock igual que en producción. */
  async function crearPedido(e: E, cantidad: number): Promise<string> {
    const res = await http()
      .post('/orders')
      .set(e.cliente)
      .send({
        customerId: e.cliUserId,
        addressId: e.dir.addressId,
        paymentMethod: 'cash',
        items: [
          {
            gasCylinderId: e.garrafa.gasCylinderId,
            quantity: cantidad,
            unitPrice: 1,
          },
        ],
      });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return (res.body as { order_id: string }).order_id;
  }

  const stockDe = async (e: E) =>
    (
      await ds
        .getRepository(GasCylinder)
        .findOneByOrFail({ gasCylinderId: e.garrafa.gasCylinderId })
    ).stock;
  const pedidoDe = (orderId: string) =>
    ds.getRepository(Order).findOneByOrFail({ orderId });
  const renglonesDe = (orderId: string) =>
    ds.getRepository(OrderItem).find({ where: { orderId } });

  it('el cliente dueño cambia cantidades: el precio es del servidor (aunque el body traiga precios), ajusta la reserva y deja la anotación', async () => {
    const e = await escenario();
    const id = await crearPedido(e, 2);
    expect(await stockDe(e)).toBe(48);

    const res = await http()
      .patch(`/orders/${id}`)
      .set(e.cliente)
      .send({
        notes: 'Tocar timbre',
        items: [{ gasCylinderId: e.garrafa.gasCylinderId, quantity: 5 }],
      });
    expect(res.status).toBe(200);
    const pedido = await pedidoDe(id);
    expect(pedido.totalAmount).toBe(5000);
    expect(pedido.notes).toBe('Tocar timbre');
    expect((await renglonesDe(id)).map((r) => r.quantity)).toEqual([5]);
    expect(await stockDe(e)).toBe(45);

    const historial = await ds
      .getRepository(OrderStatusHistory)
      .find({ where: { orderId: id }, order: { changedAt: 'ASC' } });
    const nota = historial.find((f) => f.fromStatus === f.toStatus);
    expect(nota?.reason).toContain(
      'Pedido modificado por el cliente: renglones, notas. Total: 2000 → 5000',
    );
    expect(nota?.changedByUserId).toBe(e.cliUserId);

    // Bajar la cantidad devuelve la diferencia.
    await http()
      .patch(`/orders/${id}`)
      .set(e.cliente)
      .send({
        items: [{ gasCylinderId: e.garrafa.gasCylinderId, quantity: 1 }],
      })
      .expect(200);
    expect(await stockDe(e)).toBe(49);
    expect((await pedidoDe(id)).totalAmount).toBe(1000);
  });

  it('el cuerpo no admite precios ni campos de admin (400) y el pedido no cambia', async () => {
    const e = await escenario();
    const id = await crearPedido(e, 1);
    const item = { gasCylinderId: e.garrafa.gasCylinderId, quantity: 2 };
    const prohibidos: Record<string, unknown>[] = [
      { totalAmount: 1, items: [item] },
      { items: [{ ...item, unitPrice: 1 }] },
      { status: 'delivered' },
      { deliveryId: e.del.deliveryId },
      { customerId: randomUUID() },
    ];
    for (const cuerpo of prohibidos) {
      const res = await http()
        .patch(`/orders/${id}`)
        .set(e.cliente)
        .send(cuerpo);
      expect(res.status).toBe(400);
    }
    const pedido = await pedidoDe(id);
    expect(pedido.totalAmount).toBe(1000);
    expect(pedido.status).toBe(OrderStatus.PENDING);
    expect(pedido.deliveryId).toBeNull();
  });

  it('la misma garrafa en dos renglones es 400', async () => {
    const e = await escenario();
    const id = await crearPedido(e, 1);
    const g = e.garrafa.gasCylinderId;
    const res = await http()
      .patch(`/orders/${id}`)
      .set(e.cliente)
      .send({
        items: [
          { gasCylinderId: g, quantity: 1 },
          { gasCylinderId: g, quantity: 2 },
        ],
      });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(
      'no puede repetir la misma garrafa',
    );
  });

  it('un PATCH vacío o con los mismos valores responde 200 sin escribir historial ni stock', async () => {
    const e = await escenario();
    const id = await crearPedido(e, 2);
    const filas = () =>
      ds.getRepository(OrderStatusHistory).count({ where: { orderId: id } });
    const antes = await filas();
    for (const cuerpo of [
      {},
      { paymentMethod: 'cash', addressId: e.dir.addressId },
      { items: [{ gasCylinderId: e.garrafa.gasCylinderId, quantity: 2 }] },
    ]) {
      const res = await http()
        .patch(`/orders/${id}`)
        .set(e.cliente)
        .send(cuerpo);
      expect(res.status).toBe(200);
    }
    expect(await filas()).toBe(antes);
    expect(await stockDe(e)).toBe(48);
  });

  it('dos ediciones concurrentes del cliente se aplican en serie y el stock queda exacto', async () => {
    const e = await escenario();
    const id = await crearPedido(e, 2);
    const g = e.garrafa.gasCylinderId;
    // El despacho tiene el lock un momento: las dos ediciones esperan, no dan 409.
    const redis = env.app.get(RedisService);
    const [a, b] = await redis
      .withLock(`dispatch:offer:${id}`, 5000, async () => {
        const ediciones = Promise.all([
          http()
            .patch(`/orders/${id}`)
            .set(e.cliente)
            .send({ items: [{ gasCylinderId: g, quantity: 5 }] }),
          http()
            .patch(`/orders/${id}`)
            .set(e.cliente)
            .send({ items: [{ gasCylinderId: g, quantity: 3 }] }),
        ]);
        await esperar(700);
        return { ediciones };
      })
      .then((r) =>
        r.obtenido ? r.valor.ediciones : Promise.reject(new Error('sin lock')),
      );
    expect([a.status, b.status]).toEqual([200, 200]);
    const cantidad = (await renglonesDe(id)).reduce(
      (t, r) => t + r.quantity,
      0,
    );
    expect([3, 5]).toContain(cantidad);
    expect(await stockDe(e)).toBe(50 - cantidad);
    expect((await pedidoDe(id)).totalAmount).toBe(cantidad * 1000);
  });

  it('mientras el despacho ofrece el pedido (lock dispatch:offer) la edición responde 409 y no escribe; liberado, edita', async () => {
    const e = await escenario();
    const id = await crearPedido(e, 2);
    const redis = env.app.get(RedisService);
    const cuerpo = {
      items: [{ gasCylinderId: e.garrafa.gasCylinderId, quantity: 3 }],
    };
    const durante = await redis.withLock(`dispatch:offer:${id}`, 10000, () =>
      http().patch(`/orders/${id}`).set(e.cliente).send(cuerpo),
    );
    expect(durante.obtenido && durante.valor.status).toBe(409);
    expect(await stockDe(e)).toBe(48);
    const despues = await http()
      .patch(`/orders/${id}`)
      .set(e.cliente)
      .send(cuerpo);
    expect(despues.status).toBe(200);
    expect(await stockDe(e)).toBe(47);
  });

  it('un cliente que no es el dueño recibe 404 y el pedido no cambia; el chofer, 403', async () => {
    const e = await escenario();
    const id = await crearPedido(e, 2);
    const ajeno = await http()
      .patch(`/orders/${id}`)
      .set(e.cliente2)
      .send({ notes: 'hack' });
    expect(ajeno.status).toBe(404);
    const chofer = await http()
      .patch(`/orders/${id}`)
      .set(e.chofer)
      .send({ notes: 'hack' });
    expect(chofer.status).toBe(403);
    expect((await pedidoDe(id)).notes).toBeNull();
  });

  it('con chofer asignado responde 409 con el mensaje del repartidor y no toca stock', async () => {
    const e = await escenario();
    const id = await crearPedido(e, 2);
    await forzarEstado(
      ds,
      `UPDATE "order" SET status = 'accepted', delivery_id = $1 WHERE order_id = $2`,
      [e.del.deliveryId, id],
    );
    const res = await http()
      .patch(`/orders/${id}`)
      .set(e.cliente)
      .send({
        items: [{ gasCylinderId: e.garrafa.gasCylinderId, quantity: 9 }],
      });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      message:
        'El pedido ya fue tomado por un repartidor: no se puede modificar',
    });
    expect(await stockDe(e)).toBe(48);
  });

  it('con un cobro online generado (MercadoPago) responde 409', async () => {
    const e = await escenario();
    const id = await crearPedido(e, 1);
    await ds.query(
      `UPDATE "order" SET "paymentMethod" = 'mercadopago' WHERE order_id = $1`,
      [id],
    );
    const res = await http()
      .patch(`/orders/${id}`)
      .set(e.cliente)
      .send({ paymentMethod: PaymentMethod.CASH });
    expect(res.status).toBe(409);
  });

  describe('carrera con la aceptación del chofer', () => {
    it('con el pedido bloqueado por la aceptación, la edición espera y al confirmarse se rechaza (409) sin tocar el stock', async () => {
      const e = await escenario();
      const id = await crearPedido(e, 2);
      const qr = ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      await qr.query(`SELECT 1 FROM "order" WHERE order_id = $1 FOR UPDATE`, [
        id,
      ]);
      await forzarEstado(
        qr,
        `UPDATE "order" SET status = 'accepted', delivery_id = $1 WHERE order_id = $2`,
        [e.del.deliveryId, id],
      );
      let terminado = false;
      const edicion = http()
        .patch(`/orders/${id}`)
        .set(e.cliente)
        .send({
          items: [{ gasCylinderId: e.garrafa.gasCylinderId, quantity: 7 }],
        })
        .then((r) => {
          terminado = true;
          return r;
        });
      await esperar(1500);
      // Sin el lock de fila, la edición leería `pending` y ya habría terminado.
      expect(terminado).toBe(false);
      await qr.commitTransaction();
      await qr.release();
      const res = await edicion;
      expect(res.status).toBe(409);
      expect(await stockDe(e)).toBe(48);
      expect((await renglonesDe(id)).map((r) => r.quantity)).toEqual([2]);
    });

    it('editar y aceptar en paralelo: o el chofer toma el pedido original (y la edición es 409) o la edición entra antes; nunca stock ni renglones incoherentes', async () => {
      const e = await escenario();
      for (let i = 0; i < 6; i += 1) {
        await ds.query(
          `UPDATE gas_cylinder SET stock = 50 WHERE gas_cylinder_id = $1`,
          [e.garrafa.gasCylinderId],
        );
        const id = await crearPedido(e, 2);
        const [edicion, aceptacion] = await Promise.all([
          http()
            .patch(`/orders/${id}`)
            .set(e.cliente)
            .send({
              items: [{ gasCylinderId: e.garrafa.gasCylinderId, quantity: 4 }],
            }),
          http()
            .patch(`/orders/${id}/status`)
            .set(e.chofer)
            .send({ status: 'accepted' }),
        ]);
        const pedido = await pedidoDe(id);
        const cantidad = (await renglonesDe(id)).map((r) => r.quantity);
        const resultado = {
          edicion: edicion.status,
          estado: pedido.status,
          cantidad,
          total: pedido.totalAmount,
          stock: await stockDe(e),
        };
        const editoPrimero = {
          edicion: 200,
          estado: OrderStatus.ACCEPTED,
          cantidad: [4],
          total: 4000,
          stock: 46,
        };
        const aceptoPrimero = {
          edicion: 409,
          estado: OrderStatus.ACCEPTED,
          cantidad: [2],
          total: 2000,
          stock: 48,
        };
        expect([editoPrimero, aceptoPrimero]).toContainEqual(resultado);
        expect(aceptacion.status).toBe(200);
        await forzarEstado(
          ds,
          `UPDATE "order" SET status = 'cancelled' WHERE order_id = $1`,
          [id],
        );
        await ds.query(
          `UPDATE gas_cylinder SET stock = 50 WHERE gas_cylinder_id = $1`,
          [e.garrafa.gasCylinderId],
        );
        await ds.query(`DELETE FROM order_item WHERE order_id = $1`, [id]);
      }
    });
  });

  describe('cotización de edición (POST /orders/quote con orderId)', () => {
    const cotizar = (
      e: E,
      quien: Headers,
      orderId: string,
      cuerpo: {
        items?: { gasCylinderId: string; quantity: number }[];
        timeSlotId?: string;
        scheduledDate?: string;
      } = {},
    ) =>
      http()
        .post('/orders/quote')
        .set(quien)
        .send({
          paymentMethod: 'cash',
          ...cuerpo,
          orderId,
          items: (
            cuerpo.items ?? [
              { gasCylinderId: e.garrafa.gasCylinderId, quantity: 2 },
            ]
          ).map((i) => ({ ...i, unitPrice: 1 })),
        });

    async function franjaPropia(
      e: E,
      id: string,
      franja: Partial<TimeSlot>,
      fecha: string,
    ) {
      const slot = await ds.getRepository(TimeSlot).save({
        distributorId: e.dist.distributorId,
        name: 'Propia',
        startTime: '00:00',
        endTime: '23:59',
        capacity: 1,
        isActive: true,
        ...franja,
      } as Partial<TimeSlot>);
      await ds.query(
        `UPDATE "order" SET time_slot_id = $1, scheduled_date = $2 WHERE order_id = $3`,
        [slot.timeSlotId, fecha, id],
      );
      return slot;
    }
    const manana = () => {
      const d = new Date(`${diaArgentino()}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };

    it('cotiza igual que el PATCH guarda y no escribe nada', async () => {
      const e = await escenario();
      const id = await crearPedido(e, 2);
      const q = await cotizar(e, e.cliente, id, {
        items: [{ gasCylinderId: e.garrafa.gasCylinderId, quantity: 5 }],
      });
      expect(q.status).toBe(200);
      expect((q.body as { total: number }).total).toBe(5000);
      expect(await stockDe(e)).toBe(48);
      expect((await renglonesDe(id)).map((r) => r.quantity)).toEqual([2]);
      const p = await http()
        .patch(`/orders/${id}`)
        .set(e.cliente)
        .send({
          items: [
            {
              gasCylinderId: e.garrafa.gasCylinderId,
              quantity: 5,
            },
          ],
        });
      expect(p.status).toBe(200);
      expect((await pedidoDe(id)).totalAmount).toBe(5000);
    });

    it('franja propia llena: cotizar y guardar con la misma franja y fecha anda (cupo 1, ocupado por el propio pedido)', async () => {
      const e = await escenario();
      const id = await crearPedido(e, 2);
      await franjaPropia(e, id, {}, manana());
      const q = await cotizar(e, e.cliente, id, {
        items: [{ gasCylinderId: e.garrafa.gasCylinderId, quantity: 3 }],
      });
      expect(q.status).toBe(200);
      const p = await http()
        .patch(`/orders/${id}`)
        .set(e.cliente)
        .send({
          items: [
            {
              gasCylinderId: e.garrafa.gasCylinderId,
              quantity: 3,
            },
          ],
        });
      expect(p.status).toBe(200);
    });

    it('franja propia ya terminada (hoy): sin cambiar la agenda se cotiza y se guarda', async () => {
      const e = await escenario();
      const id = await crearPedido(e, 2);
      await franjaPropia(
        e,
        id,
        { startTime: '00:00', endTime: '00:01', capacity: 10 },
        diaArgentino(),
      );
      const items = [{ gasCylinderId: e.garrafa.gasCylinderId, quantity: 3 }];
      const q = await cotizar(e, e.cliente, id, { items });
      expect(q.status).toBe(200);
      const p = await http().patch(`/orders/${id}`).set(e.cliente).send({
        items,
      });
      expect(p.status).toBe(200);
    });

    it('si cambia a una franja llena de otro pedido, cotizar y guardar dan 400', async () => {
      const e = await escenario();
      const id = await crearPedido(e, 2);
      const otro = await crearPedido(e, 1);
      const llena = await franjaPropia(e, otro, {}, manana());
      const cuerpo = { timeSlotId: llena.timeSlotId, scheduledDate: manana() };
      expect((await cotizar(e, e.cliente, id, cuerpo)).status).toBe(400);
      const p = await http().patch(`/orders/${id}`).set(e.cliente).send(cuerpo);
      expect(p.status).toBe(400);
    });

    it('sin scheduledDate en el pedido ni en el cuerpo no se asigna fecha', async () => {
      const e = await escenario();
      const id = await crearPedido(e, 2);
      const q = await cotizar(e, e.cliente, id);
      expect(q.status).toBe(200);
      await http()
        .patch(`/orders/${id}`)
        .set(e.cliente)
        .send({ notes: 'x' })
        .expect(200);
      expect((await pedidoDe(id)).scheduledDate).toBeNull();
    });

    it('stock justo: delta 0 y negativo se cotizan; delta positivo sin stock falla', async () => {
      const e = await escenario();
      const id = await crearPedido(e, 3);
      await ds.query(
        `UPDATE gas_cylinder SET stock = 0 WHERE gas_cylinder_id = $1`,
        [e.garrafa.gasCylinderId],
      );
      const con = (quantity: number) => ({
        items: [{ gasCylinderId: e.garrafa.gasCylinderId, quantity }],
      });
      expect((await cotizar(e, e.cliente, id, con(3))).status).toBe(200);
      expect((await cotizar(e, e.cliente, id, con(1))).status).toBe(200);
      expect((await cotizar(e, e.cliente, id, con(4))).status).toBe(400);
      expect(await stockDe(e)).toBe(0);
    });

    it('un pedido ajeno o inexistente es 404', async () => {
      const e = await escenario();
      const id = await crearPedido(e, 2);
      expect((await cotizar(e, e.cliente2, id)).status).toBe(404);
      expect((await cotizar(e, e.cliente, randomUUID())).status).toBe(404);
    });

    it('un pedido no editable es 409 con el mismo mensaje que el PATCH', async () => {
      const e = await escenario();
      const id = await crearPedido(e, 2);
      await forzarEstado(
        ds,
        `UPDATE "order" SET status = 'accepted', delivery_id = $2 WHERE order_id = $1`,
        [id, e.del.deliveryId],
      );
      const q = await cotizar(e, e.cliente, id);
      const p = await http()
        .patch(`/orders/${id}`)
        .set(e.cliente)
        .send({ notes: 'x' });
      expect([q.status, p.status]).toEqual([409, 409]);
      expect((q.body as { message: string }).message).toBe(
        (p.body as { message: string }).message,
      );
    });
  });
});
