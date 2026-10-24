/**
 * C-10 contra la API con Postgres y Redis reales:
 *  - CU-127: `PATCH /orders/:id/address`, el cliente cambia la dirección de un
 *    pedido pendiente o aceptado (cobertura, recargo, historial, avisos).
 *  - CU-128: `PATCH /orders/:id/receiver`, quién recibe el pedido: quién lo ve,
 *    la auditoría sin el documento y el proceso diario que lo anula.
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
import { Admin } from '../../src/admin/entities/admin.entity';
import { Car } from '../../src/car/entities/car.entity';
import { VehicleAssignment } from '../../src/car/entities/vehicle-assignment.entity';
import { CoverageZone } from '../../src/coverage-zone/entities/coverage-zone.entity';
import { Claim, ClaimStatus } from '../../src/claims/entities/claim.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import {
  DispatchOffer,
  DispatchOfferStatus,
} from '../../src/order/entities/dispatch-offer.entity';
import { OrderAddressChange } from '../../src/order/entities/order-address-change.entity';
import { OrderStatusHistory } from '../../src/order/entities/order-status-history.entity';
import { Order, OrderStatus } from '../../src/order/entities/order.entity';
import { ReceiverRetentionCron } from '../../src/order/application/receiver-retention.cron';
import { RealtimeDispatchPort } from '../../src/order/domain/ports/realtime-dispatch.port';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { conBypassManager } from './setup/bypass';

type Headers = Record<string, string>;

/** Cuadrado de ±0,02° alrededor de un punto, como anillo GeoJSON [lng, lat]. */
const cuadrado = (lng: number, lat: number) => ({
  type: 'Polygon' as const,
  coordinates: [
    [
      [lng - 0.02, lat - 0.02],
      [lng + 0.02, lat - 0.02],
      [lng + 0.02, lat + 0.02],
      [lng - 0.02, lat + 0.02],
      [lng - 0.02, lat - 0.02],
    ],
  ],
});

const ZONA_A = { lng: -58.38, lat: -34.6 };
const ZONA_B = { lng: -58.3, lat: -34.6 };
const AFUERA = { lng: -57.0, lat: -34.0 };

const receptor = {
  receiverName: 'María Gómez',
  receiverDocument: '30.123.456',
  receiverRelationship: 'vecina',
};

describe('Dirección de entrega y quién recibe el pedido (C-10, e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let realtime: RealtimeDispatchPort;
  let seq = 0;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    realtime = env.app.get(RealtimeDispatchPort);
  }, 240000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  const espias: jest.SpyInstance[] = [];
  afterEach(() => {
    while (espias.length > 0) espias.pop()?.mockRestore();
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

  async function direccion(
    userId: string,
    punto: { lng: number; lat: number },
    calle: string,
  ) {
    return ds.getRepository(UserAddress).save({
      userId,
      street: calle,
      city: 'CABA',
      location: { type: 'Point', coordinates: [punto.lng, punto.lat] },
    } as unknown as Partial<UserAddress>);
  }

  async function nuevoChofer(d: Distributor, nombre: string, punto = ZONA_A) {
    const c = await usuario('delivery', nombre);
    const del = await ds.getRepository(Delivery).save({
      userId: c.user.userId,
      distributorId: d.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>);
    const auto = await ds.getRepository(Car).save({
      distributorId: d.distributorId,
      userId: c.user.userId,
      carPatent: `T${seq}${randomUUID().slice(0, 4).toUpperCase()}`,
    } as Partial<Car>);
    await ds.getRepository(VehicleAssignment).save({
      distributorId: d.distributorId,
      carId: auto.carId,
      deliveryId: del.deliveryId,
      assignedAt: new Date(),
    } as Partial<VehicleAssignment>);
    await realtime.reportDriverLocation(c.user.userId, punto.lat, punto.lng);
    return { del, userId: c.user.userId, headers: h(c.email, 'delivery-app') };
  }

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
    const otraDist = await ds.getRepository(Distributor).save({
      name: 'Distribuidora B',
      slug: `distb-${seq}-${randomUUID().slice(0, 4)}`,
      legalName: 'Test SRL',
      taxId: `31-${seq}${Date.now()}`,
      email: `b${seq}${Date.now()}@test.local`,
      phone: '+540000000001',
    } as Partial<Distributor>);
    const zonas = ds.getRepository(CoverageZone);
    await zonas.save({
      distributorId: dist.distributorId,
      name: 'Centro',
      area: cuadrado(ZONA_A.lng, ZONA_A.lat),
      surchargeType: 'percentage',
      surchargeValue: 10,
    } as unknown as Partial<CoverageZone>);
    await zonas.save({
      distributorId: dist.distributorId,
      name: 'Norte',
      area: cuadrado(ZONA_B.lng, ZONA_B.lat),
      surchargeType: 'percentage',
      surchargeValue: 25,
    } as unknown as Partial<CoverageZone>);

    const cli = await usuario('customer', 'Cliente Uno');
    const cli2 = await usuario('customer', 'Cliente Dos');
    for (const c of [cli, cli2]) {
      await ds.getRepository(Customer).save({
        userId: c.user.userId,
        notificationToken: 'fake',
      } as Partial<Customer>);
    }
    const a1 = await direccion(cli.user.userId, ZONA_A, 'Calle A 1');
    const a2 = await direccion(cli.user.userId, ZONA_B, 'Calle B 2');
    const a3 = await direccion(
      cli.user.userId,
      { lng: ZONA_A.lng + 0.005, lat: ZONA_A.lat },
      'Calle A 3',
    );
    const aFuera = await direccion(cli.user.userId, AFUERA, 'Calle lejana');
    const ajena = await direccion(cli2.user.userId, ZONA_B, 'Calle del otro');
    const garrafa = await ds.getRepository(GasCylinder).save({
      type: '10kg',
      price: 1000,
      stock: 50,
      weight: 10,
      isActive: true,
      distributorId: dist.distributorId,
    } as Partial<GasCylinder>);
    const chofer = await nuevoChofer(dist, 'Ana Chofer');

    const adm = await usuario('admin', 'Admin');
    await ds.getRepository(Admin).save({
      userId: adm.user.userId,
      distributorId: dist.distributorId,
    } as Partial<Admin>);
    const admB = await usuario('admin', 'Admin B');
    await ds.getRepository(Admin).save({
      userId: admB.user.userId,
      distributorId: otraDist.distributorId,
    } as Partial<Admin>);

    const dX = { 'X-Distributor': dist.slug };
    return {
      dist,
      otraDist,
      a1,
      a2,
      a3,
      aFuera,
      ajena,
      garrafa,
      chofer,
      cliente: h(cli.email, 'customer-app', dX),
      cliente2: h(cli2.email, 'customer-app', dX),
      clienteOtraDist: h(cli.email, 'customer-app', {
        'X-Distributor': otraDist.slug,
      }),
      admin: h(adm.email, 'panel-app'),
      adminB: h(admB.email, 'panel-app'),
      cliUserId: cli.user.userId,
    };
  }
  type E = Awaited<ReturnType<typeof escenario>>;

  async function crearPedido(
    e: E,
    opciones: { metodo?: 'cash' | 'transfer'; cantidad?: number } = {},
  ): Promise<string> {
    const res = await http()
      .post('/orders')
      .set(e.cliente)
      .send({
        customerId: e.cliUserId,
        addressId: e.a1.addressId,
        paymentMethod: opciones.metodo ?? 'cash',
        items: [
          {
            gasCylinderId: e.garrafa.gasCylinderId,
            quantity: opciones.cantidad ?? 2,
            unitPrice: 1,
          },
        ],
      });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return (res.body as { order_id: string }).order_id;
  }

  const pedidoDe = (orderId: string) =>
    ds.getRepository(Order).findOneByOrFail({ orderId });
  const cambiosDe = (orderId: string) =>
    ds.getRepository(OrderAddressChange).find({ where: { orderId } });
  const direccionDe = (e: E, id: string, cuerpo: object, headers?: Headers) =>
    http()
      .patch(`/orders/${id}/address`)
      .set(headers ?? e.cliente)
      .send(cuerpo);
  const receptorDe = (id: string, cuerpo: object, headers: Headers) =>
    http().patch(`/orders/${id}/receiver`).set(headers).send(cuerpo);

  /** Deja al pedido tomado por el chofer, como si lo hubiera aceptado. */
  const aceptar = (id: string, e: E, estado = OrderStatus.ACCEPTED) =>
    ds
      .getRepository(Order)
      .update(
        { orderId: id },
        { status: estado, deliveryId: e.chofer.del.deliveryId },
      );

  describe('CU-127 · cambiar la dirección de entrega', () => {
    it('pendiente en efectivo: recalcula el total con el recargo de la zona nueva, mueve el punto de entrega y asienta el cambio', async () => {
      const e = await escenario();
      const id = await crearPedido(e); // 2 x 1000, zona Centro 10%
      expect((await pedidoDe(id)).totalAmount).toBe(2200);

      const res = await direccionDe(e, id, {
        addressId: e.a2.addressId,
        reason: 'Me mudé a lo de mi mamá',
      }).expect(200);

      expect(res.body).toMatchObject({
        order_id: id,
        total_amount: 2500,
        delivery_address: { address_id: e.a2.addressId },
      });
      const p = await pedidoDe(id);
      expect(p).toMatchObject({
        addressId: e.a2.addressId,
        totalAmount: 2500,
        zoneSurchargeAmount: 500,
        zoneName: 'Norte',
        status: OrderStatus.PENDING,
      });
      expect(p.deliveryPoint?.coordinates).toEqual([ZONA_B.lng, ZONA_B.lat]);

      const cambios = await cambiosDe(id);
      expect(cambios).toHaveLength(1);
      expect(cambios[0]).toMatchObject({
        fromAddressId: e.a1.addressId,
        toAddressId: e.a2.addressId,
        changedByUserId: e.cliUserId,
        reason: 'Me mudé a lo de mi mamá',
      });
      const nota = (
        await ds
          .getRepository(OrderStatusHistory)
          .find({ where: { orderId: id } })
      ).find((f) => f.fromStatus === f.toStatus);
      expect(nota?.reason).toContain('Total: 2200 → 2500');
    });

    it('aceptado: avisa al chofer asignado por su id de usuario y al panel, y no lo vuelve a ofrecer', async () => {
      const e = await escenario();
      const id = await crearPedido(e);
      await aceptar(id, e);
      const alChofer = jest.spyOn(realtime, 'notifyDriverOrderAddressChanged');
      espias.push(alChofer);
      const alPanel = jest.spyOn(realtime, 'notifyAdmins');
      espias.push(alPanel);

      await direccionDe(e, id, { addressId: e.a3.addressId }).expect(200);

      expect(alChofer).toHaveBeenCalledWith(
        e.chofer.userId,
        expect.objectContaining({ orderId: id, toAddressId: e.a3.addressId }),
      );
      expect(alPanel).toHaveBeenCalledWith(
        'order:address-changed',
        expect.objectContaining({ orderId: id }),
        e.dist.distributorId,
      );
      const p = await pedidoDe(id);
      expect(p).toMatchObject({
        status: OrderStatus.ACCEPTED,
        deliveryId: e.chofer.del.deliveryId,
        addressId: e.a3.addressId,
      });
      expect((await cambiosDe(id))[0].reason).toBeNull();
    });

    it('pendiente con una oferta viva: se vence y se vuelve a ofrecer con el punto nuevo', async () => {
      const e = await escenario();
      const id = await crearPedido(e);
      await esperar(300);
      const ofertas = () =>
        ds
          .getRepository(DispatchOffer)
          .find({ where: { orderId: id }, order: { offeredAt: 'ASC' } });
      const antes = await ofertas();
      expect(antes.map((o) => o.status)).toEqual([DispatchOfferStatus.OFFERED]);

      const alChofer = jest.spyOn(realtime, 'notifyDriverOrderCancelled');
      espias.push(alChofer);
      await direccionDe(e, id, { addressId: e.a3.addressId }).expect(200);

      const despues = await ofertas();
      expect(despues[0].status).toBe(DispatchOfferStatus.SUPERSEDED);
      expect(
        despues.some((o) => o.status === DispatchOfferStatus.OFFERED),
      ).toBe(true);
      expect(alChofer).toHaveBeenCalledWith(
        e.chofer.userId,
        expect.objectContaining({ orderId: id }),
      );
    });

    it.each([OrderStatus.ON_THE_WAY, OrderStatus.DELIVERED])(
      'un pedido %s ya salió: 409 y nada cambia',
      async (estado) => {
        const e = await escenario();
        const id = await crearPedido(e);
        await aceptar(id, e, estado);
        const res = await direccionDe(e, id, {
          addressId: e.a2.addressId,
        }).expect(409);
        expect(JSON.stringify(res.body)).toContain('ya salió');
        expect((await pedidoDe(id)).addressId).toBe(e.a1.addressId);
        expect(await cambiosDe(id)).toHaveLength(0);
      },
    );

    it('un pedido cancelado tampoco admite el cambio (409)', async () => {
      const e = await escenario();
      const id = await crearPedido(e);
      await http()
        .patch(`/orders/${id}/cancel`)
        .set(e.cliente)
        .send({})
        .expect(200);
      await direccionDe(e, id, { addressId: e.a2.addressId }).expect(409);
    });

    it('fuera de la zona de cobertura: 400 con el motivo y el pedido queda como estaba', async () => {
      const e = await escenario();
      const id = await crearPedido(e);
      const res = await direccionDe(e, id, {
        addressId: e.aFuera.addressId,
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain(
        'fuera de la zona de cobertura',
      );
      expect(await pedidoDe(id)).toMatchObject({
        addressId: e.a1.addressId,
        totalAmount: 2200,
      });
      expect(await cambiosDe(id)).toHaveLength(0);
    });

    it('una dirección de otro cliente es 404; la misma dirección que ya tiene, 400', async () => {
      const e = await escenario();
      const id = await crearPedido(e);
      await direccionDe(e, id, { addressId: e.ajena.addressId }).expect(404);
      await direccionDe(e, id, { addressId: randomUUID() }).expect(404);
      await direccionDe(e, id, { addressId: e.a1.addressId }).expect(400);
      expect(await cambiosDe(id)).toHaveLength(0);
    });

    it('pago en línea: si el recargo de la zona nueva es distinto, 409 sin cambios; si es el mismo, cambia y conserva el total', async () => {
      const e = await escenario();
      const id = await crearPedido(e, { metodo: 'transfer' });
      const total = (await pedidoDe(id)).totalAmount;

      const res = await direccionDe(e, id, {
        addressId: e.a2.addressId,
      }).expect(409);
      expect(JSON.stringify(res.body)).toContain('cancelalo y hacelo de nuevo');
      expect(await pedidoDe(id)).toMatchObject({
        addressId: e.a1.addressId,
        totalAmount: total,
      });
      expect(await cambiosDe(id)).toHaveLength(0);

      await direccionDe(e, id, { addressId: e.a3.addressId }).expect(200);
      expect(await pedidoDe(id)).toMatchObject({
        addressId: e.a3.addressId,
        totalAmount: total,
      });
    });

    it('aislamiento: otro cliente, otra distribuidora, el admin y el chofer no pueden', async () => {
      const e = await escenario();
      const id = await crearPedido(e);
      await direccionDe(
        e,
        id,
        { addressId: e.a2.addressId },
        e.cliente2,
      ).expect(404);
      await direccionDe(
        e,
        id,
        { addressId: e.a2.addressId },
        e.clienteOtraDist,
      ).expect(404);
      await direccionDe(e, id, { addressId: e.a2.addressId }, e.admin).expect(
        403,
      );
      await direccionDe(
        e,
        id,
        { addressId: e.a2.addressId },
        e.chofer.headers,
      ).expect(403);
      expect((await pedidoDe(id)).addressId).toBe(e.a1.addressId);
    });

    it('el cuerpo exige un addressId uuid y rechaza campos de más', async () => {
      const e = await escenario();
      const id = await crearPedido(e);
      await direccionDe(e, id, {}).expect(400);
      await direccionDe(e, id, { addressId: 'no-uuid' }).expect(400);
      await direccionDe(e, id, {
        addressId: e.a2.addressId,
        totalAmount: 1,
      }).expect(400);
    });

    it('con la misma Idempotency-Key el reintento no repite el cambio', async () => {
      const e = await escenario();
      const id = await crearPedido(e);
      const clave = randomUUID();
      for (let i = 0; i < 2; i++) {
        await http()
          .patch(`/orders/${id}/address`)
          .set({ ...e.cliente, 'Idempotency-Key': clave })
          .send({ addressId: e.a2.addressId })
          .expect(200);
      }
      expect(await cambiosDe(id)).toHaveLength(1);
    });

    it('carrera con la aceptación del chofer (endpoint real): el cambio ve al chofer asignado y le avisa', async () => {
      const e = await escenario();
      const id = await crearPedido(e);
      await esperar(300); // la oferta al chofer ya está viva
      const alChofer = jest.spyOn(realtime, 'notifyDriverOrderAddressChanged');
      espias.push(alChofer);

      // Una transacción tiene tomado el pedido: la aceptación y el cambio de
      // dirección esperan, en ese orden. Al soltarlo, la aceptación entra
      // primero y el cambio tiene que leer al chofer recién asignado.
      const bloqueo = ds.createQueryRunner();
      await bloqueo.connect();
      await bloqueo.startTransaction();
      await bloqueo.query(
        `SELECT 1 FROM "order" WHERE order_id = $1 FOR UPDATE`,
        [id],
      );
      try {
        const aceptacion = http()
          .patch(`/orders/${id}/status`)
          .set(e.chofer.headers)
          .send({ status: 'accepted' })
          .then((r) => r);
        await esperar(400);
        const cambio = direccionDe(e, id, { addressId: e.a3.addressId }).then(
          (r) => r,
        );
        await esperar(400);
        await bloqueo.commitTransaction();
        const [rAceptar, rCambiar] = await Promise.all([aceptacion, cambio]);
        expect(rAceptar.status).toBe(200);
        expect(rCambiar.status).toBe(200);
      } finally {
        if (bloqueo.isTransactionActive) await bloqueo.rollbackTransaction();
        await bloqueo.release();
      }

      const p = await pedidoDe(id);
      expect(p).toMatchObject({
        status: OrderStatus.ACCEPTED,
        deliveryId: e.chofer.del.deliveryId,
        addressId: e.a3.addressId,
      });
      expect(alChofer).toHaveBeenCalledWith(
        e.chofer.userId,
        expect.objectContaining({ orderId: id, toAddressId: e.a3.addressId }),
      );
      expect(await cambiosDe(id)).toHaveLength(1);
    });

    it('carrera: el pedido sale en camino mientras se cambia la dirección; gana uno solo', async () => {
      const e = await escenario();
      const id = await crearPedido(e);
      await aceptar(id, e);
      const [cambio] = await Promise.all([
        direccionDe(e, id, { addressId: e.a3.addressId }),
        conBypassManager(ds, ['transiciones'], (m) =>
          m
            .getRepository(Order)
            .update({ orderId: id }, { status: OrderStatus.ON_THE_WAY }),
        ),
      ]);
      const p = await pedidoDe(id);
      expect([200, 409]).toContain(cambio.status);
      expect(p.addressId).toBe(
        cambio.status === 200 ? e.a3.addressId : e.a1.addressId,
      );
      expect(await cambiosDe(id)).toHaveLength(cambio.status === 200 ? 1 : 0);
    });

    describe('cobertura de la distribuidora', () => {
      it('nunca definió zonas: cubre todo sin recargo y el cambio entra', async () => {
        const e = await escenario();
        const id = await crearPedido(e);
        await ds.query(`DELETE FROM coverage_zone WHERE distributor_id = $1`, [
          e.dist.distributorId,
        ]);
        const res = await direccionDe(e, id, {
          addressId: e.aFuera.addressId,
        }).expect(200);
        expect(res.body).toMatchObject({ total_amount: 2000 });
      });

      it('tiene zonas pero todas apagadas: no cubre nada y el cambio se rechaza', async () => {
        const e = await escenario();
        const id = await crearPedido(e);
        await ds.query(
          `UPDATE coverage_zone SET "isActive" = false WHERE distributor_id = $1`,
          [e.dist.distributorId],
        );
        const res = await direccionDe(e, id, {
          addressId: e.a3.addressId,
        }).expect(400);
        expect(JSON.stringify(res.body)).toContain(
          'fuera de la zona de cobertura',
        );
        expect((await pedidoDe(id)).addressId).toBe(e.a1.addressId);
        expect(await cambiosDe(id)).toHaveLength(0);
        // También el alta de un pedido nuevo.
        await http()
          .post('/orders')
          .set(e.cliente)
          .send({
            customerId: e.cliUserId,
            addressId: e.a1.addressId,
            paymentMethod: 'cash',
            items: [
              {
                gasCylinderId: e.garrafa.gasCylinderId,
                quantity: 1,
                unitPrice: 1,
              },
            ],
          })
          .expect(400);
      });

      it('zona vencida que el barrido todavía no apagó: no cuenta (sin hueco de 5 minutos)', async () => {
        const e = await escenario();
        const id = await crearPedido(e);
        await ds.query(
          `UPDATE coverage_zone SET valid_until = now() - interval '1 minute' WHERE distributor_id = $1`,
          [e.dist.distributorId],
        );
        const activas: unknown[] = await ds.query(
          `SELECT 1 FROM coverage_zone WHERE distributor_id = $1 AND "isActive"`,
          [e.dist.distributorId],
        );
        expect(activas.length).toBeGreaterThan(0); // el cron no pasó
        await direccionDe(e, id, { addressId: e.a3.addressId }).expect(400);
        expect((await pedidoDe(id)).addressId).toBe(e.a1.addressId);
      });
    });
  });

  describe('CU-128 · indicar quién recibe el pedido', () => {
    const consultar = (id: string, headers: Headers) =>
      http().get(`/orders/${id}`).set(headers);

    it('el cliente indica quién recibe; el documento se guarda normalizado y el pedido lo expone', async () => {
      const e = await escenario();
      const id = await crearPedido(e);

      const res = await receptorDe(id, receptor, e.cliente).expect(200);
      expect(res.body).toMatchObject({
        order_id: id,
        receiver: {
          name: 'María Gómez',
          document: '30123456',
          relationship: 'vecina',
        },
      });
      expect(await pedidoDe(id)).toMatchObject({
        receiverName: 'María Gómez',
        receiverDocument: '30123456',
        receiverRelationship: 'vecina',
      });

      // Cambiar de idea: lo nuevo reemplaza a lo anterior.
      await receptorDe(
        id,
        { ...receptor, receiverName: 'Pedro Gómez' },
        e.cliente,
      ).expect(200);
      expect((await pedidoDe(id)).receiverName).toBe('Pedro Gómez');
    });

    it('lo ven el cliente dueño, el chofer asignado y el administrador; no el chofer del pool ni quien no es dueño', async () => {
      const e = await escenario();
      const id = await crearPedido(e);
      await receptorDe(id, receptor, e.cliente).expect(200);
      const otroChofer = await nuevoChofer(e.dist, 'Otro Chofer');

      // Pendiente y sin dueño de chofer: el pool no lo muestra.
      const pool = await http()
        .get('/orders/available')
        .set(otroChofer.headers)
        .expect(200);
      const delPool = (
        pool.body as { orders: Array<{ order_id: string; receiver: unknown }> }
      ).orders.find((o) => o.order_id === id);
      expect(delPool).toBeDefined();
      expect(delPool?.receiver).toBeNull();
      const comoOferta = await consultar(id, otroChofer.headers).expect(200);
      expect((comoOferta.body as { receiver: unknown }).receiver).toBeNull();

      await aceptar(id, e);
      const asignado = await consultar(id, e.chofer.headers).expect(200);
      expect(
        (asignado.body as { receiver: { name: string } }).receiver.name,
      ).toBe('María Gómez');
      const delAdmin = await consultar(id, e.admin).expect(200);
      expect(
        (delAdmin.body as { receiver: { name: string } }).receiver.name,
      ).toBe('María Gómez');
      const delCliente = await consultar(id, e.cliente).expect(200);
      expect(
        (delCliente.body as { receiver: { document: string } }).receiver
          .document,
      ).toBe('30123456');
      // Otro cliente y el admin de otra distribuidora no ven el pedido.
      await consultar(id, e.cliente2).expect(404);
      await consultar(id, e.adminB).expect(404);
    });

    it('rechaza documentos con formato inválido y datos faltantes (400)', async () => {
      const e = await escenario();
      const id = await crearPedido(e);
      for (const cuerpo of [
        { ...receptor, receiverDocument: '123' },
        { ...receptor, receiverDocument: '' },
        { ...receptor, receiverName: '   ' },
        { ...receptor, receiverRelationship: undefined },
        { ...receptor, extra: 1 },
      ]) {
        await receptorDe(id, cuerpo, e.cliente).expect(400);
      }
      expect((await pedidoDe(id)).receiverName).toBeNull();
    });

    it('un pedido entregado o cancelado se rechaza (409) y no cambia', async () => {
      const e = await escenario();
      const entregado = await crearPedido(e);
      await aceptar(entregado, e, OrderStatus.DELIVERED);
      await receptorDe(entregado, receptor, e.cliente).expect(409);
      expect((await pedidoDe(entregado)).receiverName).toBeNull();

      const cancelado = await crearPedido(e);
      await http()
        .patch(`/orders/${cancelado}/cancel`)
        .set(e.cliente)
        .send({})
        .expect(200);
      await receptorDe(cancelado, receptor, e.cliente).expect(409);
    });

    it('aislamiento: otro cliente y otra distribuidora reciben 404; admin y chofer, 403', async () => {
      const e = await escenario();
      const id = await crearPedido(e);
      await receptorDe(id, receptor, e.cliente2).expect(404);
      await receptorDe(id, receptor, e.clienteOtraDist).expect(404);
      await receptorDe(id, receptor, e.admin).expect(403);
      await receptorDe(id, receptor, e.chofer.headers).expect(403);
      expect((await pedidoDe(id)).receiverName).toBeNull();
    });

    it('ningún dato de quien recibe queda en la auditoría (ni en la bitácora ni en el detalle de datos)', async () => {
      const e = await escenario();
      const id = await crearPedido(e);
      await receptorDe(id, receptor, e.cliente).expect(200);

      // Control: la auditoría de datos está activa y registró el alta del pedido.
      let altaAuditada = false;
      for (let i = 0; i < 30 && !altaAuditada; i++) {
        await esperar(200);
        const filas: unknown[] = await ds.query(
          `SELECT 1 FROM audit_detail WHERE field = 'totalAmount' AND new_value = '2200'`,
        );
        altaAuditada = filas.length > 0;
      }
      expect(altaAuditada).toBe(true);
      // ... y la edición del receptor por la API (audit_log) también quedó registrada.
      const registrada: unknown[] = await ds.query(
        `SELECT 1 FROM audit_log WHERE path = '/orders/:id/receiver'`,
      );
      expect(registrada.length).toBeGreaterThan(0);

      const enDetalle: unknown[] = await ds.query(
        `SELECT 1 FROM audit_detail WHERE field LIKE 'receiver%'
            OR old_value ~ '(30123456|María Gómez|vecina)'
            OR new_value ~ '(30123456|María Gómez|vecina)'`,
      );
      expect(enDetalle).toHaveLength(0);
      const enBitacora: unknown[] = await ds.query(
        `SELECT 1 FROM audit_log WHERE changes::text ~ '(30123456|30\\.123\\.456|María Gómez|vecina)'`,
      );
      expect(enBitacora).toHaveLength(0);
      const depurado: unknown[] = await ds.query(
        `SELECT 1 FROM audit_log WHERE path = '/orders/:id/receiver'
            AND changes->>'receiverDocument' = '[depurado]'
            AND changes->>'receiverName' = '[depurado]'
            AND changes->>'receiverRelationship' = '[depurado]'`,
      );
      expect(depurado.length).toBeGreaterThan(0);
    });

    it('el alta del pedido acepta quién recibe, con las mismas validaciones y visibilidad', async () => {
      const e = await escenario();
      const cuerpo = (receiver: object) => ({
        customerId: e.cliUserId,
        addressId: e.a1.addressId,
        paymentMethod: 'cash',
        items: [
          { gasCylinderId: e.garrafa.gasCylinderId, quantity: 1, unitPrice: 1 },
        ],
        receiver,
      });
      const malo = await http()
        .post('/orders')
        .set(e.cliente)
        .send(cuerpo({ ...receptor, receiverDocument: '12' }));
      expect(malo.status).toBe(400);

      const ok = await http()
        .post('/orders')
        .set(e.cliente)
        .send(cuerpo(receptor));
      expect(ok.status).toBe(201);
      const id = (ok.body as { order_id: string }).order_id;
      expect(ok.body).toMatchObject({
        receiver: {
          name: 'María Gómez',
          document: '30123456',
          relationship: 'vecina',
        },
      });
      expect(await pedidoDe(id)).toMatchObject({
        receiverName: 'María Gómez',
        receiverDocument: '30123456',
      });

      // Un chofer que ve el pedido desde el pool no lo ve.
      const otroChofer = await nuevoChofer(e.dist, 'Otro Chofer');
      const pool = await http()
        .get('/orders/available')
        .set(otroChofer.headers)
        .expect(200);
      const delPool = (
        pool.body as { orders: Array<{ order_id: string; receiver: unknown }> }
      ).orders.find((o) => o.order_id === id);
      expect(delPool?.receiver).toBeNull();
      // Y la bitácora HTTP no guarda los datos.
      const enBitacora: unknown[] = await ds.query(
        `SELECT 1 FROM audit_log WHERE path = '/orders' AND changes::text ~ '(30123456|María Gómez|vecina)'`,
      );
      expect(enBitacora).toHaveLength(0);
    });

    it('proceso diario: anula los datos de los pedidos entregados o cancelados con el plazo de reclamo vencido y deja los demás', async () => {
      const e = await escenario();
      const conReceptor = async (
        estado: OrderStatus,
        entregadoHace?: number,
      ): Promise<string> => {
        const id = await crearPedido(e);
        await receptorDe(id, receptor, e.cliente).expect(200);
        await conBypassManager(ds, ['transiciones'], (m) =>
          m.getRepository(Order).update({ orderId: id }, { status: estado }),
        );
        if (entregadoHace !== undefined) {
          await ds.query(
            `UPDATE "order" SET "deliveredAt" = now() - make_interval(days => $2),
                    "updatedAt" = now() - make_interval(days => $2)
              WHERE order_id = $1`,
            [id, entregadoHace],
          );
        }
        return id;
      };
      const vencido = await conReceptor(OrderStatus.DELIVERED, 31);
      const vigente = await conReceptor(OrderStatus.DELIVERED, 29);
      const pendiente = await conReceptor(OrderStatus.PENDING);
      const canceladoVencido = await conReceptor(OrderStatus.CANCELLED, 31);

      const limpiados = await env.app.get(ReceiverRetentionCron).barrer();
      expect(limpiados).toBe(2);

      expect(await pedidoDe(vencido)).toMatchObject({
        receiverName: null,
        receiverDocument: null,
        receiverRelationship: null,
      });
      expect((await pedidoDe(canceladoVencido)).receiverName).toBeNull();
      expect((await pedidoDe(vigente)).receiverName).toBe('María Gómez');
      expect((await pedidoDe(pendiente)).receiverName).toBe('María Gómez');

      const visto = await http()
        .get(`/orders/${vencido}`)
        .set(e.cliente)
        .expect(200);
      expect((visto.body as { receiver: unknown }).receiver).toBeNull();
      expect(await env.app.get(ReceiverRetentionCron).barrer()).toBe(0);
    });

    it('proceso diario: con un reclamo abierto sobre el pedido no anula hasta que se cierre, y deja asentada la anulación sin los datos', async () => {
      const e = await escenario();
      const id = await crearPedido(e);
      await receptorDe(id, receptor, e.cliente).expect(200);
      await conBypassManager(ds, ['transiciones'], (m) =>
        m
          .getRepository(Order)
          .update({ orderId: id }, { status: OrderStatus.DELIVERED }),
      );
      await ds.query(
        `UPDATE "order" SET "deliveredAt" = now() - interval '40 days' WHERE order_id = $1`,
        [id],
      );
      const reclamo = await ds.getRepository(Claim).save({
        orderId: id,
        customerId: e.cliUserId,
        distributorId: e.dist.distributorId,
        reason: 'Mala atención',
        description: 'x',
        status: ClaimStatus.IN_PROCESS,
      } as Partial<Claim>);
      const cron = env.app.get(ReceiverRetentionCron);

      expect(await cron.barrer()).toBe(0);
      expect((await pedidoDe(id)).receiverName).toBe('María Gómez');

      await conBypassManager(ds, ['transiciones'], (m) =>
        m
          .getRepository(Claim)
          .update(
            { claimId: reclamo.claimId },
            { status: ClaimStatus.RESOLVED },
          ),
      );
      expect(await cron.barrer()).toBe(1);
      expect((await pedidoDe(id)).receiverName).toBeNull();

      const asientos: Array<{ new_value: string }> = await ds.query(
        `SELECT d.new_value FROM audit a JOIN audit_detail d ON d.audit_id = a.audit_id
          WHERE a.entity = 'Order' AND a.record_id = $1 AND d.field = 'receiver'`,
        [id],
      );
      expect(asientos).toHaveLength(1);
      expect(asientos[0].new_value).toContain('anulados');
      expect(JSON.stringify(asientos)).not.toMatch(/30123456|María/);
    });
  });
});
