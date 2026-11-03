/**
 * Tests de integración (HTTP con el router real, Postgres y Redis efímeros):
 * - `GET /orders/:id/status-history` exige distribuidora al personal: el super
 *   admin sin `X-Distributor` no lee historiales de cualquier distribuidora.
 * - `GET /orders/delivery/me/active` lo resuelve su propia ruta y no
 *   `delivery/:deliveryId` ni `:id`.
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
import { MENSAJE_FALTA_DISTRIBUIDORA } from '../../src/common/decorators/current-distributor.decorator';
import { Admin } from '../../src/admin/entities/admin.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../../src/order/entities/order.entity';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { fechasSegunEstado } from './setup/pedido-valido';

type Headers = Record<string, string>;

describe('Historial de estados y pedido activo del chofer (HTTP e2e)', () => {
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

  async function usuario(
    tipo: 'customer' | 'admin' | 'super_admin' | 'delivery',
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

  async function distribuidora(nombre: string): Promise<Distributor> {
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

  const h = (email: string, fuente: string, extra: Headers = {}): Headers => ({
    Authorization: `Bearer ${email}`,
    'X-Client-Source': fuente,
    ...extra,
  });

  async function escenario() {
    const dA = await distribuidora('Distribuidora A');
    const dB = await distribuidora('Distribuidora B');
    const adminA = await usuario('admin', 'Admin A');
    await ds.getRepository(Admin).save({
      userId: adminA.user.userId,
      distributorId: dA.distributorId,
    } as Partial<Admin>);
    const adminB = await usuario('admin', 'Admin B');
    await ds.getRepository(Admin).save({
      userId: adminB.user.userId,
      distributorId: dB.distributorId,
    } as Partial<Admin>);
    const sup = await usuario('super_admin', 'Super');
    const chofer = await usuario('delivery', 'Ana Chofer');
    const delivery = await ds.getRepository(Delivery).save({
      userId: chofer.user.userId,
      distributorId: dA.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>);
    const cli = await usuario('customer', 'Cliente Uno');
    await ds.getRepository(Customer).save({
      userId: cli.user.userId,
      notificationToken: 'fake',
    } as Partial<Customer>);
    const dir = await ds.getRepository(UserAddress).save({
      userId: cli.user.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>);
    const conChofer = (estado?: OrderStatus) =>
      estado === OrderStatus.ACCEPTED ||
      estado === OrderStatus.ON_THE_WAY ||
      estado === OrderStatus.DELIVERED;
    const pedido = (parcial: Partial<Order>) =>
      ds.getRepository(Order).save({
        customerId: cli.user.userId,
        distributorId: dA.distributorId,
        addressId: dir.addressId,
        status: OrderStatus.PENDING,
        paymentMethod: PaymentMethod.CASH,
        paymentStatus: PaymentStatus.PENDING,
        totalAmount: 1000,
        subtotalItems: 1000,
        ...fechasSegunEstado(parcial.status ?? OrderStatus.PENDING),
        ...(conChofer(parcial.status) && { deliveryId: delivery.deliveryId }),
        ...parcial,
      } as Partial<Order>) as Promise<Order>;
    return {
      dA,
      delivery,
      pedido,
      adminA: h(adminA.email, 'panel-app'),
      adminB: h(adminB.email, 'panel-app'),
      supSinHeader: h(sup.email, 'panel-app'),
      supEnA: h(sup.email, 'panel-app', { 'X-Distributor': dA.slug }),
      chofer: h(chofer.email, 'delivery-app'),
      cliente: h(cli.email, 'customer-app', { 'X-Distributor': dA.slug }),
    };
  }

  describe('GET /orders/:id/status-history', () => {
    it('el super admin sin X-Distributor recibe 400; con la distribuidora del pedido, 200', async () => {
      const e = await escenario();
      const p = await e.pedido({});
      const url = `/orders/${p.orderId}/status-history`;

      const sin = await http().get(url).set(e.supSinHeader);
      expect(sin.status).toBe(400);
      expect(sin.body).toMatchObject({ message: MENSAJE_FALTA_DISTRIBUIDORA });
      expect(sin.body).not.toHaveProperty('changedBy');

      const con = await http().get(url).set(e.supEnA);
      expect(con.status).toBe(200);
      expect(Array.isArray(con.body)).toBe(true);
    });

    it('el admin de otra distribuidora recibe 404; el dueño y el admin del pedido, 200', async () => {
      const e = await escenario();
      const p = await e.pedido({});
      const url = `/orders/${p.orderId}/status-history`;
      expect((await http().get(url).set(e.adminB)).status).toBe(404);
      expect((await http().get(url).set(e.adminA)).status).toBe(200);
      expect((await http().get(url).set(e.cliente)).status).toBe(200);
    });
  });

  describe('GET /orders/delivery/me/active', () => {
    it('lo resuelve su propia ruta: 204 sin pedido (no 400 de delivery/:deliveryId ni 404 de :id)', async () => {
      const e = await escenario();
      const res = await http().get('/orders/delivery/me/active').set(e.chofer);
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
    });

    it('devuelve el pedido en curso aunque no sea de los más nuevos', async () => {
      const e = await escenario();
      const viejo = await e.pedido({
        status: OrderStatus.ACCEPTED,
        deliveryId: e.delivery.deliveryId,
        acceptedAt: new Date('2026-01-01T10:00:00Z'),
        createdAt: new Date('2026-01-01T09:00:00Z'),
      });
      for (let i = 0; i < 22; i += 1) {
        await e.pedido({
          status: OrderStatus.DELIVERED,
          paymentStatus: PaymentStatus.PAID,
          deliveryId: e.delivery.deliveryId,
          deliveredAt: new Date('2026-02-01T10:00:00Z'),
        });
      }
      const res = await http().get('/orders/delivery/me/active').set(e.chofer);
      expect(res.status).toBe(200);
      expect((res.body as { order_id: string }).order_id).toBe(viejo.orderId);
    });

    it('es sólo del chofer: el admin recibe 403', async () => {
      const e = await escenario();
      const res = await http().get('/orders/delivery/me/active').set(e.adminA);
      expect(res.status).toBe(403);
    });
  });
});
