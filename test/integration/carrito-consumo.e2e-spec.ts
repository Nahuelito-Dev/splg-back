/**
 * Integración (HTTP con el router real, Postgres y Redis efímeros): carrito
 * persistente del cliente (CU-122 a CU-126) y consumo promedio declarado
 * (CU-143 y CU-144). Aislamiento por cliente y por distribuidora, errores del
 * CUE, precio vigente vs guardado, concurrencia y la declaración en el
 * registro.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  telefonoDePrueba,
  truncateAllTables,
  cuitDePrueba,
} from './setup/test-env';
import { Admin } from '../../src/admin/entities/admin.entity';
import { Cart } from '../../src/cart/entities/cart.entity';
import { CartItem } from '../../src/cart/entities/cart-item.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { FirebaseAuthPort } from '../../src/firebase/ports/firebase-auth.port';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { OrderItem } from '../../src/order/entities/order-item.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { Role } from '../../src/role/entities/role.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { User } from '../../src/users/entities/user.entity';
import { fechasDeEntrega, sembrarChoferDeFixture } from './setup/pedido-valido';

type Headers = Record<string, string>;
interface CarritoJson {
  cartId: string | null;
  distributorId: string;
  items: {
    cartItemId: string;
    gasCylinderId: string;
    type: string;
    quantity: number;
    savedUnitPrice: number;
    currentUnitPrice: number;
    priceDifference: number;
    subtotal: number;
    available: boolean;
    hasEnoughStock: boolean;
  }[];
  totalUnits: number;
  total: number;
  hasPriceChanges: boolean;
  hasUnavailableItems: boolean;
}
interface ConsumoJson {
  cylinderTypeId: string | null;
  cylinderType: string | null;
  avgMonthlyConsumptionKg: number | null;
  nextRepurchaseEstimateAt: string | null;
}

describe('Carrito y consumo declarado (HTTP e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let seq = 0;
  let cuentasCreadas: jest.Mock;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    const firebase = env.app.get(FirebaseAuthPort);
    cuentasCreadas = jest.fn();
    jest.spyOn(firebase, 'createUserSafe').mockImplementation((datos) => {
      cuentasCreadas(datos.email);
      return Promise.resolve({ uid: `uid-${datos.email}` } as never);
    });
    jest.spyOn(firebase, 'deleteUserSafe').mockResolvedValue(undefined);
  }, 240000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  const http = () => request(env.app.getHttpServer());

  async function rol(tipo: string) {
    const roles = ds.getRepository(Role);
    return (
      (await roles.findOne({ where: { type: tipo } })) ??
      (await roles.save({ type: tipo } as Partial<Role>))
    );
  }

  async function usuario(tipo: string, nombre: string) {
    seq += 1;
    const email = `${tipo}.${seq}.${randomUUID().slice(0, 6)}@splg.local`;
    const user = await ds.getRepository(User).save({
      email,
      fullName: nombre,
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol(tipo)).roleId,
    } as Partial<User>);
    return { user, email };
  }

  const h = (
    email: string,
    extra: Headers = {},
    fuente = 'customer-app',
  ): Headers => ({
    Authorization: `Bearer ${email}`,
    'X-Client-Source': fuente,
    ...extra,
  });

  async function distribuidora(nombre: string) {
    seq += 1;
    return ds.getRepository(Distributor).save({
      name: nombre,
      slug: `dist-${seq}-${randomUUID().slice(0, 4)}`,
      legalName: 'Test SRL',
      taxId: cuitDePrueba(),
      email: `d${seq}${Date.now()}@test.local`,
      phone: '+540000000000',
    } as Partial<Distributor>);
  }

  const garrafa = (distributorId: string, parcial: Partial<GasCylinder> = {}) =>
    ds.getRepository(GasCylinder).save({
      type: '10kg',
      price: 1000,
      stock: 10,
      weight: 10,
      isActive: true,
      distributorId,
      ...parcial,
    } as Partial<GasCylinder>);

  async function escenario() {
    const distA = await distribuidora('Distribuidora A');
    const distB = await distribuidora('Distribuidora B');
    const cli1 = await usuario('customer', 'Cliente Uno');
    const cli2 = await usuario('customer', 'Cliente Dos');
    for (const c of [cli1, cli2]) {
      await ds.getRepository(Customer).save({
        userId: c.user.userId,
        notificationToken: 'fake',
      } as Partial<Customer>);
    }
    const g10 = await garrafa(distA.distributorId, { type: '10kg' });
    const g45 = await garrafa(distA.distributorId, {
      type: '45kg',
      weight: 45,
      price: 4000,
    });
    const gB = await garrafa(distB.distributorId, { type: '10kg' });
    const enA = { 'X-Distributor': distA.slug };
    const enB = { 'X-Distributor': distB.slug };
    return {
      distA,
      distB,
      cli1,
      cli2,
      g10,
      g45,
      gB,
      c1: h(cli1.email, enA),
      c1B: h(cli1.email, enB),
      c2: h(cli2.email, enA),
    };
  }

  const agregar = (cab: Headers, gasCylinderId: string, quantity: number) =>
    http().post('/cart/items').set(cab).send({ gasCylinderId, quantity });
  const carrito = async (cab: Headers) =>
    (await http().get('/cart').set(cab)).body as CarritoJson;

  describe('CU-125 consultar', () => {
    it('sin carrito responde uno vacío, no un error', async () => {
      const e = await escenario();
      const res = await http().get('/cart').set(e.c1);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        cartId: null,
        distributorId: e.distA.distributorId,
        items: [],
        total: 0,
        totalUnits: 0,
        hasPriceChanges: false,
        hasUnavailableItems: false,
      });
    });

    it('el total sale del precio vigente y cada ítem informa la diferencia con el guardado', async () => {
      const e = await escenario();
      await agregar(e.c1, e.g10.gasCylinderId, 3).expect(201);
      await ds
        .getRepository(GasCylinder)
        .update({ gasCylinderId: e.g10.gasCylinderId }, { price: 1200 });

      const c = await carrito(e.c1);

      expect(c.total).toBe(3600);
      expect(c.hasPriceChanges).toBe(true);
      expect(c.items[0]).toMatchObject({
        savedUnitPrice: 1000,
        currentUnitPrice: 1200,
        priceDifference: 200,
        subtotal: 3600,
      });
    });

    it('un tipo dado de baja después de agregarlo se muestra como no disponible y no suma', async () => {
      const e = await escenario();
      await agregar(e.c1, e.g10.gasCylinderId, 1).expect(201);
      await agregar(e.c1, e.g45.gasCylinderId, 1).expect(201);
      await ds
        .getRepository(GasCylinder)
        .update({ gasCylinderId: e.g45.gasCylinderId }, { isActive: false });

      const c = await carrito(e.c1);

      expect(c.items).toHaveLength(2);
      expect(c.items.find((i) => i.type === '45kg')).toMatchObject({
        available: false,
        subtotal: 0,
      });
      expect(c.total).toBe(1000);
      expect(c.hasUnavailableItems).toBe(true);
    });

    it('avisa si el stock no alcanza para la cantidad, sin reservar nada', async () => {
      const e = await escenario();
      await agregar(e.c1, e.g10.gasCylinderId, 4).expect(201);
      await ds
        .getRepository(GasCylinder)
        .update({ gasCylinderId: e.g10.gasCylinderId }, { stock: 2 });

      const c = await carrito(e.c1);

      expect(c.items[0].hasEnoughStock).toBe(false);
      const g = await ds.getRepository(GasCylinder).findOneByOrFail({
        gasCylinderId: e.g10.gasCylinderId,
      });
      expect(g.stock).toBe(2);
    });

    it('el carrito sobrevive: cerrar y reabrir la app devuelve lo mismo', async () => {
      const e = await escenario();
      await agregar(e.c1, e.g10.gasCylinderId, 2).expect(201);
      const antes = await carrito(e.c1);
      const despues = await carrito(e.c1);
      expect(despues).toEqual(antes);
      expect(despues.items).toHaveLength(1);
    });
  });

  describe('CU-122 agregar', () => {
    it('un tipo nuevo crea el carrito y el ítem con el precio vigente', async () => {
      const e = await escenario();
      const res = await agregar(e.c1, e.g10.gasCylinderId, 2);
      expect(res.status).toBe(201);
      const c = res.body as CarritoJson;
      expect(c.cartId).not.toBeNull();
      expect(c.total).toBe(2000);
      expect(c.items[0]).toMatchObject({
        type: '10kg',
        quantity: 2,
        savedUnitPrice: 1000,
      });
    });

    it('un tipo que ya estaba suma la cantidad, sin ítems repetidos, y renueva el precio guardado', async () => {
      const e = await escenario();
      await agregar(e.c1, e.g10.gasCylinderId, 2).expect(201);
      await ds
        .getRepository(GasCylinder)
        .update({ gasCylinderId: e.g10.gasCylinderId }, { price: 1100 });

      const c = (await agregar(e.c1, e.g10.gasCylinderId, 3))
        .body as CarritoJson;

      expect(c.items).toHaveLength(1);
      expect(c.items[0]).toMatchObject({ quantity: 5, savedUnitPrice: 1100 });
      expect(c.hasPriceChanges).toBe(false);
    });

    it.each([0, -1, 1.5, 1000])(
      'una cantidad inválida (%s) se rechaza con 400 y no crea carrito',
      async (cantidad) => {
        const e = await escenario();
        const res = await agregar(e.c1, e.g10.gasCylinderId, cantidad);
        expect(res.status).toBe(400);
        expect(await ds.getRepository(Cart).count()).toBe(0);
      },
    );

    it('no pasa del máximo por ítem acumulando altas', async () => {
      const e = await escenario();
      await agregar(e.c1, e.g10.gasCylinderId, 999).expect(201);
      const res = await agregar(e.c1, e.g10.gasCylinderId, 1);
      expect(res.status).toBe(400);
      expect((await carrito(e.c1)).items[0].quantity).toBe(999);
    });

    it('un tipo que no existe es 404', async () => {
      const e = await escenario();
      const res = await agregar(e.c1, randomUUID(), 1);
      expect(res.status).toBe(404);
      expect(await ds.getRepository(Cart).count()).toBe(0);
    });

    it('un tipo dado de baja es 404', async () => {
      const e = await escenario();
      await ds
        .getRepository(GasCylinder)
        .update({ gasCylinderId: e.g10.gasCylinderId }, { isActive: false });
      const res = await agregar(e.c1, e.g10.gasCylinderId, 1);
      expect(res.status).toBe(404);
      expect(await ds.getRepository(CartItem).count()).toBe(0);
    });

    it('un tipo de otra distribuidora es 404', async () => {
      const e = await escenario();
      const res = await agregar(e.c1, e.gB.gasCylinderId, 1);
      expect(res.status).toBe(404);
      expect(await ds.getRepository(Cart).count()).toBe(0);
    });

    it('diez altas simultáneas del mismo tipo suman todas y dejan un solo carrito y un solo ítem', async () => {
      const e = await escenario();
      const respuestas = await Promise.all(
        Array.from({ length: 10 }, () => agregar(e.c1, e.g10.gasCylinderId, 1)),
      );
      expect(respuestas.map((r) => r.status)).toEqual(Array(10).fill(201));
      expect(await ds.getRepository(Cart).count()).toBe(1);
      expect(await ds.getRepository(CartItem).count()).toBe(1);
      expect((await carrito(e.c1)).items[0].quantity).toBe(10);
    });
  });

  describe('CU-123 modificar la cantidad', () => {
    it('reemplaza la cantidad y recalcula el total', async () => {
      const e = await escenario();
      const base = (await agregar(e.c1, e.g10.gasCylinderId, 1))
        .body as CarritoJson;

      const res = await http()
        .patch(`/cart/items/${base.items[0].cartItemId}`)
        .set(e.c1)
        .send({ quantity: 4 });

      expect(res.status).toBe(200);
      expect((res.body as CarritoJson).total).toBe(4000);
      expect((res.body as CarritoJson).items[0].quantity).toBe(4);
    });

    it.each([0, -2, 2.5])(
      'la cantidad %s se rechaza con 400 y deja el ítem como estaba',
      async (cantidad) => {
        const e = await escenario();
        const base = (await agregar(e.c1, e.g10.gasCylinderId, 2))
          .body as CarritoJson;

        const res = await http()
          .patch(`/cart/items/${base.items[0].cartItemId}`)
          .set(e.c1)
          .send({ quantity: cantidad });

        expect(res.status).toBe(400);
        expect((await carrito(e.c1)).items[0].quantity).toBe(2);
      },
    );

    it('cantidad cero: el mensaje manda a quitar el ítem', async () => {
      const e = await escenario();
      const base = (await agregar(e.c1, e.g10.gasCylinderId, 2))
        .body as CarritoJson;
      const res = await http()
        .patch(`/cart/items/${base.items[0].cartItemId}`)
        .set(e.c1)
        .send({ quantity: 0 });
      expect(JSON.stringify(res.body)).toContain('quitá el ítem');
    });

    it('el ítem de otro cliente es 404 y no se toca', async () => {
      const e = await escenario();
      const base = (await agregar(e.c1, e.g10.gasCylinderId, 2))
        .body as CarritoJson;
      await agregar(e.c2, e.g10.gasCylinderId, 1).expect(201);

      const res = await http()
        .patch(`/cart/items/${base.items[0].cartItemId}`)
        .set(e.c2)
        .send({ quantity: 9 });

      expect(res.status).toBe(404);
      expect((await carrito(e.c1)).items[0].quantity).toBe(2);
    });

    it('el ítem del mismo cliente en otra distribuidora es 404', async () => {
      const e = await escenario();
      const base = (await agregar(e.c1, e.g10.gasCylinderId, 2))
        .body as CarritoJson;

      const res = await http()
        .patch(`/cart/items/${base.items[0].cartItemId}`)
        .set(e.c1B)
        .send({ quantity: 9 });

      expect(res.status).toBe(404);
    });

    it('modificar la cantidad de un tipo dado de baja es 400, como agregarlo', async () => {
      const e = await escenario();
      const base = (await agregar(e.c1, e.g10.gasCylinderId, 2))
        .body as CarritoJson;
      await ds
        .getRepository(GasCylinder)
        .update({ gasCylinderId: e.g10.gasCylinderId }, { isActive: false });

      const res = await http()
        .patch(`/cart/items/${base.items[0].cartItemId}`)
        .set(e.c1)
        .send({ quantity: 5 });

      expect(res.status).toBe(400);
      expect((await carrito(e.c1)).items[0].quantity).toBe(2);
    });

    it('un id que no es uuid es 400', async () => {
      const e = await escenario();
      const res = await http()
        .patch('/cart/items/no-es-uuid')
        .set(e.c1)
        .send({ quantity: 1 });
      expect(res.status).toBe(400);
    });
  });

  describe('CU-124 quitar', () => {
    it('borra el ítem de verdad y recalcula el total', async () => {
      const e = await escenario();
      await agregar(e.c1, e.g10.gasCylinderId, 1).expect(201);
      const base = (await agregar(e.c1, e.g45.gasCylinderId, 1))
        .body as CarritoJson;
      const id = base.items.find((i) => i.type === '45kg')!.cartItemId;

      const res = await http().delete(`/cart/items/${id}`).set(e.c1);

      expect(res.status).toBe(200);
      expect((res.body as CarritoJson).total).toBe(1000);
      expect(await ds.getRepository(CartItem).countBy({ cartItemId: id })).toBe(
        0,
      );
    });

    it('un ítem que no está en el carrito del cliente es 404', async () => {
      const e = await escenario();
      const base = (await agregar(e.c1, e.g10.gasCylinderId, 1))
        .body as CarritoJson;

      const ajeno = await http()
        .delete(`/cart/items/${base.items[0].cartItemId}`)
        .set(e.c2);
      const otraDist = await http()
        .delete(`/cart/items/${base.items[0].cartItemId}`)
        .set(e.c1B);
      const inexistente = await http()
        .delete(`/cart/items/${randomUUID()}`)
        .set(e.c1);

      expect([ajeno.status, otraDist.status, inexistente.status]).toEqual([
        404, 404, 404,
      ]);
      expect((await carrito(e.c1)).items).toHaveLength(1);
    });
  });

  describe('CU-126 vaciar', () => {
    it('borra todos los ítems y lo muestra vacío', async () => {
      const e = await escenario();
      await agregar(e.c1, e.g10.gasCylinderId, 2).expect(201);
      await agregar(e.c1, e.g45.gasCylinderId, 1).expect(201);

      const res = await http().delete('/cart').set(e.c1);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ items: [], total: 0 });
      expect(await ds.getRepository(CartItem).count()).toBe(0);
    });

    it('sin carrito no hace nada', async () => {
      const e = await escenario();
      const res = await http().delete('/cart').set(e.c1);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ cartId: null, items: [] });
    });

    it('vaciar el carrito de una distribuidora no toca el del mismo cliente en otra ni el de otro cliente', async () => {
      const e = await escenario();
      await agregar(e.c1, e.g10.gasCylinderId, 1).expect(201);
      await agregar(e.c1B, e.gB.gasCylinderId, 2).expect(201);
      await agregar(e.c2, e.g10.gasCylinderId, 3).expect(201);

      await http().delete('/cart').set(e.c1).expect(200);

      expect((await carrito(e.c1)).items).toHaveLength(0);
      expect((await carrito(e.c1B)).items[0].quantity).toBe(2);
      expect((await carrito(e.c2)).items[0].quantity).toBe(3);
    });
  });

  describe('aislamiento y permisos', () => {
    it('un carrito por cliente y distribuidora', async () => {
      const e = await escenario();
      await agregar(e.c1, e.g10.gasCylinderId, 1).expect(201);
      await agregar(e.c1B, e.gB.gasCylinderId, 1).expect(201);
      expect(
        await ds.getRepository(Cart).countBy({ userId: e.cli1.user.userId }),
      ).toBe(2);
      expect((await carrito(e.c1)).distributorId).toBe(e.distA.distributorId);
      expect((await carrito(e.c1B)).distributorId).toBe(e.distB.distributorId);
    });

    it('un cliente no ve el carrito de otro', async () => {
      const e = await escenario();
      await agregar(e.c1, e.g10.gasCylinderId, 2).expect(201);
      expect((await carrito(e.c2)).items).toEqual([]);
    });

    it('sin X-Distributor es 400, sin token 401 y un administrador 403', async () => {
      const e = await escenario();
      const sinDist = await http().get('/cart').set(h(e.cli1.email));
      const sinToken = await http()
        .get('/cart')
        .set({ 'X-Distributor': e.distA.slug });
      const admin = await usuario('admin', 'Admin');
      await ds.getRepository(Admin).save({
        userId: admin.user.userId,
        distributorId: e.distA.distributorId,
      } as Partial<Admin>);
      const comoAdmin = await http()
        .get('/cart')
        .set(h(admin.email, {}, 'panel-app'));

      expect(sinDist.status).toBe(400);
      expect(sinToken.status).toBe(401);
      expect(comoAdmin.status).toBe(403);
    });
  });

  describe('consumo declarado (CU-144)', () => {
    const consumoDe = (cab: Headers) =>
      http().get('/customers/me/consumption').set(cab);
    const corregir = (cab: Headers, cuerpo: object) =>
      http().patch('/customers/me/consumption').set(cab).send(cuerpo);

    it('sin declarar, todo viene en null', async () => {
      const e = await escenario();
      const res = await consumoDe(e.c1);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        cylinderTypeId: null,
        cylinderType: null,
        avgMonthlyConsumptionKg: null,
        nextRepurchaseEstimateAt: null,
      });
    });

    it('sin tipo habitual declarado hay que indicarlo (400)', async () => {
      const e = await escenario();
      const res = await corregir(e.c1, { quantityPerMonth: 2 });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('cylinderTypeId');
    });

    it('nunca compró: convierte a kg y estima desde ahora con la garrafa llena', async () => {
      const e = await escenario();
      const antes = Date.now();

      const res = await corregir(e.c1, {
        cylinderTypeId: e.g10.gasCylinderId,
        quantityPerMonth: 2,
      });

      expect(res.status).toBe(200);
      const c = res.body as ConsumoJson;
      expect(c).toMatchObject({
        cylinderTypeId: e.g10.gasCylinderId,
        cylinderType: '10kg',
        avgMonthlyConsumptionKg: 20,
      });
      // 10 kg a 20 kg por mes: 15 días desde ahora.
      const dias =
        (new Date(c.nextRepurchaseEstimateAt!).getTime() - antes) / 86_400_000;
      expect(dias).toBeGreaterThan(14.9);
      expect(dias).toBeLessThan(15.1);
      const ficha = await ds
        .getRepository(Customer)
        .findOneByOrFail({ userId: e.cli1.user.userId });
      expect(ficha.avgMonthlyConsumptionKg).toBe(20);
      expect(ficha.declaredCylinderTypeId).toBe(e.g10.gasCylinderId);
      expect((await consumoDe(e.c1)).body).toEqual(c);
    });

    it('con una compra entregada estima desde su fecha y sus kilos', async () => {
      const e = await escenario();
      const dir = await ds.getRepository(UserAddress).save({
        userId: e.cli1.user.userId,
        street: 'Av. Test 123',
        city: 'CABA',
        latitude: '-34.6037',
        longitude: '-58.3816',
      } as Partial<UserAddress>);
      const entregado = new Date('2026-09-01T12:00:00.000Z');
      const pedido = await ds.getRepository(Order).save({
        distributorId: e.distA.distributorId,
        customerId: e.cli1.user.userId,
        addressId: dir.addressId,
        status: OrderStatus.DELIVERED,
        paymentMethod: PaymentMethod.CASH,
        totalAmount: 2000,
        subtotalItems: 2000,
        deliveryId: (await sembrarChoferDeFixture(ds, e.distA.distributorId))
          .deliveryId,
        ...fechasDeEntrega(entregado),
      } as Partial<Order>);
      await ds.getRepository(OrderItem).save({
        orderId: pedido.orderId,
        gasCylinderId: e.g10.gasCylinderId,
        quantity: 2,
        unitPrice: 1000,
        subtotal: 2000,
      } as Partial<OrderItem>);

      const res = await corregir(e.c1, {
        cylinderTypeId: e.g10.gasCylinderId,
        quantityPerMonth: 1,
      });

      // 20 kg comprados a 10 kg por mes: 60 días desde la entrega.
      expect((res.body as ConsumoJson).nextRepurchaseEstimateAt).toBe(
        new Date(entregado.getTime() + 60 * 86_400_000).toISOString(),
      );
    });

    it('corregirlo recalcula la estimación', async () => {
      const e = await escenario();
      const a = (
        await corregir(e.c1, {
          cylinderTypeId: e.g10.gasCylinderId,
          quantityPerMonth: 1,
        })
      ).body as ConsumoJson;
      const b = (await corregir(e.c1, { quantityPerMonth: 2 }))
        .body as ConsumoJson;
      expect(b.avgMonthlyConsumptionKg).toBe(20);
      expect(new Date(b.nextRepurchaseEstimateAt!).getTime()).toBeLessThan(
        new Date(a.nextRepurchaseEstimateAt!).getTime(),
      );
    });

    it('se puede cambiar sólo la garrafa: se mantienen los kg por mes', async () => {
      const e = await escenario();
      await corregir(e.c1, {
        cylinderTypeId: e.g10.gasCylinderId,
        quantityPerMonth: 2,
      }).expect(200);

      const res = await corregir(e.c1, { cylinderTypeId: e.g45.gasCylinderId });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        cylinderTypeId: e.g45.gasCylinderId,
        cylinderType: '45kg',
        avgMonthlyConsumptionKg: 20,
      });
    });

    it('GET /users/email/:email trae el tipo de garrafa habitual del perfil de cliente', async () => {
      const e = await escenario();
      await corregir(e.c1, {
        cylinderTypeId: e.g10.gasCylinderId,
        quantityPerMonth: 2,
      }).expect(200);

      const res = await http()
        .get(`/users/email/${encodeURIComponent(e.cli1.email)}`)
        .set(e.c1);

      expect(res.status).toBe(200);
      expect((res.body as { customer: object }).customer).toMatchObject({
        declaredCylinderType: '10kg',
        declaredCylinderTypeId: e.g10.gasCylinderId,
        avgMonthlyConsumptionKg: 20,
      });
    });

    it('un cuerpo vacío es 400', async () => {
      const e = await escenario();
      expect((await corregir(e.c1, {})).status).toBe(400);
    });

    it('fuera de rango pide confirmación y no guarda; confirmado, lo acepta', async () => {
      const e = await escenario();
      const cuerpo = {
        cylinderTypeId: e.g10.gasCylinderId,
        quantityPerMonth: 100,
      };

      const sin = await corregir(e.c1, cuerpo);
      expect(sin.status).toBe(400);
      expect(JSON.stringify(sin.body)).toContain('confirmOutOfRange');
      const ficha = await ds
        .getRepository(Customer)
        .findOneByOrFail({ userId: e.cli1.user.userId });
      expect(ficha.avgMonthlyConsumptionKg).toBeNull();

      const con = await corregir(e.c1, { ...cuerpo, confirmOutOfRange: true });
      expect(con.status).toBe(200);
      expect((con.body as ConsumoJson).avgMonthlyConsumptionKg).toBe(1000);
    });

    it('un tipo inexistente, dado de baja o de otra distribuidora (con una en contexto) es 400', async () => {
      const e = await escenario();
      await ds
        .getRepository(GasCylinder)
        .update({ gasCylinderId: e.g45.gasCylinderId }, { isActive: false });

      const r = await Promise.all([
        corregir(e.c1, { cylinderTypeId: randomUUID(), quantityPerMonth: 1 }),
        corregir(e.c1, {
          cylinderTypeId: e.g45.gasCylinderId,
          quantityPerMonth: 1,
        }),
        corregir(e.c1, {
          cylinderTypeId: e.gB.gasCylinderId,
          quantityPerMonth: 1,
        }),
      ]);
      expect(r.map((x) => x.status)).toEqual([400, 400, 400]);
    });

    it('cantidades inválidas son 400 y un administrador no tiene este recurso (403)', async () => {
      const e = await escenario();
      const malas = await Promise.all(
        [0, -1, 1001, 'dos'].map((q) =>
          corregir(e.c1, {
            cylinderTypeId: e.g10.gasCylinderId,
            quantityPerMonth: q,
          }),
        ),
      );
      expect(malas.map((x) => x.status)).toEqual([400, 400, 400, 400]);

      const admin = await usuario('admin', 'Admin');
      await ds.getRepository(Admin).save({
        userId: admin.user.userId,
        distributorId: e.distA.distributorId,
      } as Partial<Admin>);
      expect((await consumoDe(h(admin.email, {}, 'panel-app'))).status).toBe(
        403,
      );
    });

    it('el consumo de un cliente no se mezcla con el de otro', async () => {
      const e = await escenario();
      await corregir(e.c1, {
        cylinderTypeId: e.g10.gasCylinderId,
        quantityPerMonth: 2,
      });
      expect(
        ((await consumoDe(e.c2)).body as ConsumoJson).avgMonthlyConsumptionKg,
      ).toBeNull();
    });
  });

  describe('CU-126 checkout del carrito (fromCart)', () => {
    async function conDireccion(e: Awaited<ReturnType<typeof escenario>>) {
      return ds.getRepository(UserAddress).save({
        userId: e.cli1.user.userId,
        street: 'Av. Test 123',
        city: 'CABA',
        latitude: '-34.6037',
        longitude: '-58.3816',
      } as Partial<UserAddress>);
    }
    const pedir = (
      e: Awaited<ReturnType<typeof escenario>>,
      cab: Headers,
      addressId: string,
      extra: object = {},
      clave: string = randomUUID(),
    ) =>
      http()
        .post('/orders')
        .set(cab)
        .set('Idempotency-Key', clave)
        .send({
          customerId: e.cli1.user.userId,
          addressId,
          paymentMethod: 'cash',
          fromCart: true,
          ...extra,
        });
    const stockDe = async (id: string) =>
      (
        await ds
          .getRepository(GasCylinder)
          .findOneByOrFail({ gasCylinderId: id })
      ).stock;
    const pedidos = () => ds.getRepository(Order).count();

    it('crea el pedido con los ítems del carrito al precio vigente y deja el carrito vacío', async () => {
      const e = await escenario();
      const dir = await conDireccion(e);
      await agregar(e.c1, e.g10.gasCylinderId, 2).expect(201);
      await agregar(e.c1, e.g45.gasCylinderId, 1).expect(201);
      await ds
        .getRepository(GasCylinder)
        .update({ gasCylinderId: e.g10.gasCylinderId }, { price: 1200 });

      const res = await pedir(e, e.c1, dir.addressId);

      expect(res.status).toBe(201);
      const orderId = (res.body as { order_id: string }).order_id;
      const renglones = await ds
        .getRepository(OrderItem)
        .find({ where: { orderId } });
      expect(
        renglones.map((r) => [r.gasCylinderId, r.quantity, r.unitPrice]).sort(),
      ).toEqual(
        [
          [e.g10.gasCylinderId, 2, 1200],
          [e.g45.gasCylinderId, 1, 4000],
        ].sort(),
      );
      expect((res.body as { total_amount: number }).total_amount).toBe(6400);
      expect(await stockDe(e.g10.gasCylinderId)).toBe(8);
      const c = await carrito(e.c1);
      expect(c.items).toEqual([]);
      expect(c.total).toBe(0);
    });

    it('un pedido que falla no vacía el carrito', async () => {
      const e = await escenario();
      const dir = await conDireccion(e);
      await agregar(e.c1, e.g10.gasCylinderId, 4).expect(201);
      await ds
        .getRepository(GasCylinder)
        .update({ gasCylinderId: e.g10.gasCylinderId }, { stock: 1 });

      const res = await pedir(e, e.c1, dir.addressId);

      expect(res.status).toBe(400);
      expect(await pedidos()).toBe(0);
      expect((await carrito(e.c1)).items[0].quantity).toBe(4);
    });

    it('el reintento con la misma Idempotency-Key no duplica el pedido ni vacía de nuevo el carrito', async () => {
      const e = await escenario();
      const dir = await conDireccion(e);
      await agregar(e.c1, e.g10.gasCylinderId, 2).expect(201);
      const clave = randomUUID();

      const a = await pedir(e, e.c1, dir.addressId, {}, clave);
      // Entre el pedido y el reintento el cliente arma un carrito nuevo.
      await agregar(e.c1, e.g45.gasCylinderId, 1).expect(201);
      const b = await pedir(e, e.c1, dir.addressId, {}, clave);

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect((b.body as { order_id: string }).order_id).toBe(
        (a.body as { order_id: string }).order_id,
      );
      expect(await pedidos()).toBe(1);
      expect(await stockDe(e.g10.gasCylinderId)).toBe(8);
      expect((await carrito(e.c1)).items.map((i) => i.type)).toEqual(['45kg']);
    });

    it('carrito vacío, con items a la vez o con un producto dado de baja es 400', async () => {
      const e = await escenario();
      const dir = await conDireccion(e);

      const vacio = await pedir(e, e.c1, dir.addressId);
      await agregar(e.c1, e.g10.gasCylinderId, 1).expect(201);
      const ambos = await pedir(e, e.c1, dir.addressId, {
        items: [
          { gasCylinderId: e.g10.gasCylinderId, quantity: 1, unitPrice: 1 },
        ],
      });
      await ds
        .getRepository(GasCylinder)
        .update({ gasCylinderId: e.g10.gasCylinderId }, { isActive: false });
      const caido = await pedir(e, e.c1, dir.addressId);

      expect(vacio.status).toBe(400);
      expect(JSON.stringify(vacio.body)).toContain('carrito está vacío');
      expect(ambos.status).toBe(400);
      expect(caido.status).toBe(400);
      expect(JSON.stringify(caido.body)).toContain('10kg');
      expect(await pedidos()).toBe(0);
      expect((await carrito(e.c1)).items).toHaveLength(1);
    });

    it('sin fromCart ni items es 400, y con items sin fromCart sigue igual que siempre', async () => {
      const e = await escenario();
      const dir = await conDireccion(e);
      await agregar(e.c1, e.g10.gasCylinderId, 3).expect(201);

      const sinNada = await pedir(e, e.c1, dir.addressId, { fromCart: false });
      const clasico = await pedir(e, e.c1, dir.addressId, {
        fromCart: false,
        items: [
          { gasCylinderId: e.g10.gasCylinderId, quantity: 1, unitPrice: 1 },
        ],
      });

      expect(sinNada.status).toBe(400);
      expect(clasico.status).toBe(201);
      // El pedido clásico no toca el carrito.
      expect((await carrito(e.c1)).items[0].quantity).toBe(3);
    });

    it('otra distribuidora no ve el carrito: 400 vacío y el carrito de la primera queda intacto', async () => {
      const e = await escenario();
      const dir = await conDireccion(e);
      await agregar(e.c1, e.g10.gasCylinderId, 2).expect(201);

      const res = await pedir(e, e.c1B, dir.addressId);

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('carrito está vacío');
      expect((await carrito(e.c1)).items[0].quantity).toBe(2);
    });

    it('el personal no usa fromCart (403)', async () => {
      const e = await escenario();
      const dir = await conDireccion(e);
      const admin = await usuario('admin', 'Admin');
      await ds.getRepository(Admin).save({
        userId: admin.user.userId,
        distributorId: e.distA.distributorId,
      } as Partial<Admin>);

      const res = await pedir(
        e,
        h(admin.email, {}, 'panel-app'),
        dir.addressId,
      );

      expect(res.status).toBe(403);
    });

    it('cotizar con fromCart devuelve el desglose del carrito y no lo toca', async () => {
      const e = await escenario();
      await agregar(e.c1, e.g10.gasCylinderId, 2).expect(201);

      const res = await http()
        .post('/orders/quote')
        .set(e.c1)
        .send({ fromCart: true, paymentMethod: 'cash' });

      expect(res.status).toBe(200);
      expect((res.body as { total: number }).total).toBe(2000);
      expect((await carrito(e.c1)).items[0].quantity).toBe(2);
    });
  });

  describe('ficha del cliente en el panel', () => {
    it('el super admin ve el consumo declarado, el tipo habitual y la recompra estimada', async () => {
      const e = await escenario();
      await http()
        .patch('/customers/me/consumption')
        .set(e.c1)
        .send({ cylinderTypeId: e.g10.gasCylinderId, quantityPerMonth: 2 })
        .expect(200);
      const sa = await usuario('super_admin', 'Super');
      await ds.getRepository(Admin).save({
        userId: sa.user.userId,
        distributorId: null,
      } as Partial<Admin>);

      const lista = await http()
        .get('/customers')
        .set(h(sa.email, {}, 'panel-app'));
      const uno = await http()
        .get(`/customers/user/${e.cli1.user.userId}`)
        .set(h(sa.email, {}, 'panel-app'));

      const sinDeclarar = (lista.body as { user_id: string }[]).find(
        (c) => c.user_id === e.cli2.user.userId,
      );
      expect(uno.status).toBe(200);
      expect(uno.body).toMatchObject({
        avgMonthlyConsumptionKg: 20,
        declaredCylinderType: '10kg',
      });
      expect(
        (uno.body as { nextRepurchaseEstimateAt: string })
          .nextRepurchaseEstimateAt,
      ).toEqual(expect.any(String));
      expect(sinDeclarar).toMatchObject({
        avgMonthlyConsumptionKg: null,
        declaredCylinderType: null,
        nextRepurchaseEstimateAt: null,
      });
    });
  });

  describe('CU-143 declarar al registrarse', () => {
    const registro = (extra: object = {}) => {
      seq += 1;
      return http()
        .post('/auth/registro')
        .send({
          email: `nuevo${seq}.${randomUUID().slice(0, 6)}@splg.local`,
          password: 'Test1234',
          full_name: 'Cliente Nuevo',
          phone_number: telefonoDePrueba(),
          ...extra,
        });
    };

    beforeEach(async () => {
      await rol('customer');
    });

    it('el cliente declara su consumo y queda en su ficha con la recompra estimada', async () => {
      const e = await escenario();

      const res = await registro({
        consumption: {
          cylinderTypeId: e.g10.gasCylinderId,
          quantityPerMonth: 2,
        },
      });

      expect(res.status).toBe(201);
      const userId = (res.body as { user_id: string }).user_id;
      const ficha = await ds
        .getRepository(Customer)
        .findOneByOrFail({ userId });
      expect(ficha.avgMonthlyConsumptionKg).toBe(20);
      expect(ficha.declaredCylinderTypeId).toBe(e.g10.gasCylinderId);
      expect(ficha.nextRepurchaseEstimateAt).toBeInstanceOf(Date);
    });

    it('si prefiere no declararlo, el registro sigue y el dato queda vacío', async () => {
      const res = await registro();
      expect(res.status).toBe(201);
      const ficha = await ds
        .getRepository(Customer)
        .findOneByOrFail({ userId: (res.body as { user_id: string }).user_id });
      expect(ficha.avgMonthlyConsumptionKg).toBeNull();
      expect(ficha.nextRepurchaseEstimateAt).toBeNull();
    });

    it('fuera de rango sin confirmar corta el registro: no queda usuario ni cuenta de Firebase', async () => {
      const e = await escenario();
      const usuarios = await ds.getRepository(User).count();
      const creadas = cuentasCreadas.mock.calls.length;

      const res = await registro({
        consumption: {
          cylinderTypeId: e.g10.gasCylinderId,
          quantityPerMonth: 100,
        },
      });

      expect(res.status).toBe(400);
      expect(await ds.getRepository(User).count()).toBe(usuarios);
      expect(cuentasCreadas.mock.calls.length).toBe(creadas);
    });

    it('fuera de rango y confirmado, el registro lo acepta', async () => {
      const e = await escenario();
      const res = await registro({
        consumption: {
          cylinderTypeId: e.g10.gasCylinderId,
          quantityPerMonth: 100,
          confirmOutOfRange: true,
        },
      });
      expect(res.status).toBe(201);
    });

    it('un tipo de garrafa inexistente es 400 y no crea el usuario', async () => {
      await escenario();
      const usuarios = await ds.getRepository(User).count();
      const res = await registro({
        consumption: { cylinderTypeId: randomUUID(), quantityPerMonth: 1 },
      });
      expect(res.status).toBe(400);
      expect(await ds.getRepository(User).count()).toBe(usuarios);
    });
  });
});
