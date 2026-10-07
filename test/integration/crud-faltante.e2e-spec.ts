/**
 * CRUD faltante de las tablas del panel contra la API con Postgres real:
 * franjas, envases, pedidos pendientes, reclamos, incidencias, calificaciones,
 * roles y administradores. Cada bloque cubre el caso feliz, el 409 de estado,
 * el 404 de otra distribuidora y que la baja sea lógica.
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
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { Admin } from '../../src/admin/entities/admin.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { TimeSlot } from '../../src/time-slot/entities/time-slot.entity';
import {
  Cylinder,
  CylinderState,
} from '../../src/cylinder/entities/cylinder.entity';
import { CylinderMovement } from '../../src/cylinder/entities/cylinder-movement.entity';
import { Claim, ClaimStatus } from '../../src/claims/entities/claim.entity';
import {
  Incident,
  IncidentStatus,
  IncidentType,
} from '../../src/incident/entities/incident.entity';
import { Rating, RaterRole } from '../../src/rating/entities/rating.entity';
import { RoleType } from '../../src/common/constants/role-type.enum';

interface Quien {
  user: User;
  headers: Record<string, string>;
}

describe('CRUD faltante de las tablas del panel (e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  // ---------- semillas ----------

  async function rol(type: string): Promise<Role> {
    const roles = ds.getRepository(Role);
    return (
      (await roles.findOne({ where: { type } })) ??
      (await roles.save({ type } as Partial<Role>))
    );
  }

  async function distribuidora(): Promise<Distributor> {
    const s = randomUUID().slice(0, 8);
    return ds
      .getRepository(Distributor)
      .save({ name: `Dist ${s}`, slug: `dist-${s}` } as Partial<Distributor>);
  }

  async function usuario(
    tipo: RoleType,
    distributorId: string | null,
  ): Promise<Quien> {
    const s = randomUUID().slice(0, 8);
    const email = `${tipo}.${s}@splg.local`;
    const user = await ds.getRepository(User).save({
      email,
      fullName: `Test ${tipo} ${s}`,
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol(tipo)).roleId,
    } as Partial<User>);
    if (tipo === RoleType.ADMIN || tipo === RoleType.SUPER_ADMIN) {
      await ds
        .getRepository(Admin)
        .save({ userId: user.userId, distributorId } as Partial<Admin>);
    } else if (tipo === RoleType.CUSTOMER) {
      await ds
        .getRepository(Customer)
        .save({ userId: user.userId } as Partial<Customer>);
    } else if (tipo === RoleType.DELIVERY && distributorId) {
      await ds
        .getRepository(Delivery)
        .save({ userId: user.userId, distributorId } as Partial<Delivery>);
    }
    return {
      user,
      headers: {
        Authorization: `Bearer ${email}`,
        'X-Client-Source':
          tipo === RoleType.CUSTOMER ? 'customer-app' : 'panel-app',
      },
    };
  }

  /** Dos distribuidoras, un admin de cada una y un cliente. */
  async function escenario() {
    const a = await distribuidora();
    const b = await distribuidora();
    const adminA = await usuario(RoleType.ADMIN, a.distributorId);
    const adminB = await usuario(RoleType.ADMIN, b.distributorId);
    const cliente = await usuario(RoleType.CUSTOMER, null);
    return { a, b, adminA, adminB, cliente };
  }

  async function direccion(userId: string): Promise<UserAddress> {
    return ds.getRepository(UserAddress).save({
      userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>);
  }

  async function producto(
    distributorId: string,
    over: Partial<GasCylinder> = {},
  ): Promise<GasCylinder> {
    return ds.getRepository(GasCylinder).save({
      type: '10kg',
      price: 1000,
      stock: 10,
      weight: 10,
      isActive: true,
      distributorId,
      ...over,
    } as Partial<GasCylinder>);
  }

  async function pedidoDirecto(
    distributorId: string,
    customerId: string,
    status: OrderStatus = OrderStatus.DELIVERED,
  ): Promise<Order> {
    const address = await direccion(customerId);
    return ds.getRepository(Order).save({
      customerId,
      distributorId,
      addressId: address.addressId,
      status,
      paymentMethod: PaymentMethod.CASH,
      totalAmount: 1000,
      subtotalItems: 1000,
    } as Partial<Order>);
  }

  const http = () => request(env.app.getHttpServer());
  const patch = (q: Quien, url: string, body: object = {}) =>
    http().patch(url).set(q.headers).send(body);
  const get = (q: Quien, url: string) => http().get(url).set(q.headers);
  const del = (q: Quien, url: string) => http().delete(url).set(q.headers);
  const json = <T>(r: request.Response): T => r.body as T;

  // ---------- 1. franjas horarias ----------

  describe('franjas horarias', () => {
    it('PATCH edita parcialmente, valida el rango, reactiva y respeta el tenant', async () => {
      const { a, adminA, adminB } = await escenario();
      const franja = await ds.getRepository(TimeSlot).save({
        distributorId: a.distributorId,
        name: 'Mañana',
        startTime: '09:00',
        endTime: '13:00',
        capacity: 50,
      } as Partial<TimeSlot>);
      const url = `/time-slot/${franja.timeSlotId}`;

      const editada = await patch(adminA, url, {
        name: 'Mañana temprano',
        capacity: 20,
      }).expect(200);
      expect(editada.body).toMatchObject({
        name: 'Mañana temprano',
        capacity: 20,
        startTime: '09:00:00',
        isActive: true,
      });

      await patch(adminA, url, { startTime: '14:00' }).expect(400);
      await patch(adminA, url, { startTime: '25:99' }).expect(400);
      await patch(adminB, url, { name: 'robo' }).expect(404);

      await del(adminA, url).expect(200);
      const reactivada = await patch(adminA, url, { isActive: true }).expect(
        200,
      );
      expect(json<{ isActive: boolean }>(reactivada).isActive).toBe(true);
    }, 30000);
  });

  // ---------- 2. envases ----------

  describe('envases físicos', () => {
    async function envase(
      distributorId: string,
      state = CylinderState.IN_DEPOT,
      serial = `SN-${randomUUID().slice(0, 6)}`,
    ): Promise<Cylinder> {
      return ds
        .getRepository(Cylinder)
        .save({ distributorId, serial, state } as Partial<Cylinder>);
    }

    it('PATCH edita datos maestros, no el estado, y el serial repetido es 409', async () => {
      const { a, adminA, adminB } = await escenario();
      const uno = await envase(a.distributorId, CylinderState.IN_DEPOT, 'SN-1');
      await envase(a.distributorId, CylinderState.IN_DEPOT, 'SN-2');

      const r = await patch(adminA, `/cylinders/${uno.cylinderId}`, {
        serial: 'SN-1B',
        deposit: 7000,
        manufacturedAt: '2020-05-01T00:00:00.000Z',
        expiresAt: '2030-05-01T00:00:00.000Z',
      }).expect(200);
      expect(r.body).toMatchObject({
        serial: 'SN-1B',
        deposit: 7000,
        state: 'in_depot',
      });
      expect((r.body as { expires_at: string }).expires_at).toContain('2030');

      await patch(adminA, `/cylinders/${uno.cylinderId}`, {
        serial: 'SN-2',
      }).expect(409);
      await patch(adminA, `/cylinders/${uno.cylinderId}`, {
        state: 'filled',
      }).expect(400);
      await patch(adminB, `/cylinders/${uno.cylinderId}`, {
        serial: 'X',
      }).expect(404);
    }, 30000);

    it('retire: desde IN_DEPOT y EMPTY_RETURNED con motivo; nunca con cliente; terminal', async () => {
      const { a, adminA, adminB, cliente } = await escenario();
      const enDeposito = await envase(a.distributorId);
      const vacio = await envase(a.distributorId, CylinderState.EMPTY_RETURNED);
      const conCliente = await envase(
        a.distributorId,
        CylinderState.WITH_CUSTOMER,
      );
      const enReparto = await envase(a.distributorId, CylinderState.DISPATCHED);
      void cliente;

      await patch(
        adminA,
        `/cylinders/${enDeposito.cylinderId}/retire`,
        {},
      ).expect(400);
      await patch(adminA, `/cylinders/${enDeposito.cylinderId}/retire`, {
        reason: '   ',
      }).expect(400);
      await patch(adminB, `/cylinders/${enDeposito.cylinderId}/retire`, {
        reason: 'x',
      }).expect(404);

      const baja = await patch(
        adminA,
        `/cylinders/${enDeposito.cylinderId}/retire`,
        { reason: 'Prueba hidráulica vencida' },
      ).expect(200);
      expect(baja.body).toMatchObject({ state: 'retired' });
      await patch(adminA, `/cylinders/${vacio.cylinderId}/retire`, {
        reason: 'Oxidado',
      }).expect(200);

      for (const c of [conCliente, enReparto]) {
        await patch(adminA, `/cylinders/${c.cylinderId}/retire`, {
          reason: 'no se puede',
        }).expect(400);
      }

      // El motivo queda en el historial y el registro no se borra.
      const historial = await get(
        adminA,
        `/cylinders/${enDeposito.cylinderId}/history`,
      ).expect(200);
      const ultimo =
        json<Array<{ to_state: string; note: string }>>(historial).pop();
      expect(ultimo).toMatchObject({
        to_state: 'retired',
        note: 'Baja: Prueba hidráulica vencida',
      });
      expect(await ds.getRepository(Cylinder).count()).toBe(4);

      // Terminal: ni se edita, ni transiciona, ni se despacha a un pedido.
      await patch(adminA, `/cylinders/${enDeposito.cylinderId}`, {
        serial: 'otro',
      }).expect(409);
      await patch(adminA, `/cylinders/${enDeposito.cylinderId}/transition`, {
        toState: 'in_depot',
      }).expect(400);
      await patch(adminA, `/cylinders/${enDeposito.cylinderId}/transition`, {
        toState: 'retired',
      }).expect(400);
      const pedido = await pedidoDirecto(
        a.distributorId,
        cliente.user.userId,
        OrderStatus.PENDING,
      );
      await http()
        .post('/cylinders/assign')
        .set(adminA.headers)
        .send({ orderId: pedido.orderId, serials: [enDeposito.serial] })
        .expect(400);
      expect(
        await ds.getRepository(CylinderMovement).count({
          where: { cylinderId: enDeposito.cylinderId },
        }),
      ).toBe(1);

      const filtrado = await get(adminA, '/cylinders?state=retired').expect(
        200,
      );
      expect(json<unknown[]>(filtrado)).toHaveLength(2);
    }, 30000);
  });

  // ---------- 3. pedidos ----------

  describe('pedidos pendientes', () => {
    async function pedidoPorApi(
      distributorId: string,
      slug: string,
      cliente: Quien,
      producto1: GasCylinder,
      cantidad = 2,
    ) {
      const address = await direccion(cliente.user.userId);
      const r = await http()
        .post('/orders')
        .set({ ...cliente.headers, 'X-Distributor': slug })
        .send({
          customerId: cliente.user.userId,
          addressId: address.addressId,
          paymentMethod: 'cash',
          items: [
            {
              gasCylinderId: producto1.gasCylinderId,
              quantity: cantidad,
              unitPrice: 1000,
            },
          ],
        })
        .expect(201);
      void distributorId;
      return { id: json<{ order_id: string }>(r).order_id, address };
    }

    const stockDe = async (id: string) =>
      (
        await ds
          .getRepository(GasCylinder)
          .findOneByOrFail({ gasCylinderId: id })
      ).stock;

    it('PATCH reemplaza renglones con stock y precios del servidor, y edita notas/pago/dirección', async () => {
      const { a, adminA, cliente } = await escenario();
      const p1 = await producto(a.distributorId, { stock: 10, price: 1000 });
      const p2 = await producto(a.distributorId, {
        type: '15kg',
        stock: 5,
        price: 1800,
      });
      const { id } = await pedidoPorApi(
        a.distributorId,
        a.slug,
        cliente,
        p1,
        2,
      );
      expect(await stockDe(p1.gasCylinderId)).toBe(8);

      const nueva = await direccion(cliente.user.userId);
      const r = await patch(adminA, `/orders/${id}`, {
        notes: 'Timbre 2B',
        paymentMethod: 'transfer',
        addressId: nueva.addressId,
        items: [{ gasCylinderId: p2.gasCylinderId, quantity: 3 }],
      }).expect(200);
      const pedido = json<{
        customer_notes: string;
        payment_method: string;
        total_amount: number;
        order_items: Array<{ quantity: number; unit_price: number }>;
      }>(r);
      expect(pedido.customer_notes).toBe('Timbre 2B');
      expect(pedido.payment_method).toBe('online');
      expect(pedido.order_items).toHaveLength(1);
      expect(pedido.order_items[0]).toMatchObject({
        quantity: 3,
        unit_price: 1800,
      });
      // 3 x 1800 = 5400, +10% por pago online.
      expect(pedido.total_amount).toBeCloseTo(5940, 2);

      // El stock viejo volvió y el nuevo se reservó.
      expect(await stockDe(p1.gasCylinderId)).toBe(10);
      expect(await stockDe(p2.gasCylinderId)).toBe(2);
      const guardado = await ds
        .getRepository(Order)
        .findOneByOrFail({ orderId: id });
      expect(guardado.addressId).toBe(nueva.addressId);
      expect(
        await ds
          .getRepository(Order)
          .manager.query(
            `SELECT count(*)::int AS n FROM order_address_change WHERE order_id = $1`,
            [id],
          ),
      ).toEqual([{ n: 1 }]);
    }, 60000);

    it('sin stock suficiente: 400 y no cambia nada (rollback)', async () => {
      const { a, adminA, cliente } = await escenario();
      const p1 = await producto(a.distributorId, { stock: 10 });
      const p2 = await producto(a.distributorId, { type: '15kg', stock: 1 });
      const { id } = await pedidoPorApi(
        a.distributorId,
        a.slug,
        cliente,
        p1,
        2,
      );

      const r = await patch(adminA, `/orders/${id}`, {
        items: [{ gasCylinderId: p2.gasCylinderId, quantity: 5 }],
      });
      expect(r.status).toBe(400);
      expect(await stockDe(p1.gasCylinderId)).toBe(8);
      expect(await stockDe(p2.gasCylinderId)).toBe(1);
      const quedan = await ds
        .getRepository(Order)
        .findOneOrFail({ where: { orderId: id }, relations: ['items'] });
      expect(quedan.items).toHaveLength(1);
      expect(quedan.items[0].gasCylinderId).toBe(p1.gasCylinderId);
    }, 60000);

    it('fuera de pending (o con chofer) es 409 y no toca el stock; otra distribuidora es 404', async () => {
      const { a, adminA, adminB, cliente } = await escenario();
      const p1 = await producto(a.distributorId, { stock: 10 });
      const { id } = await pedidoPorApi(
        a.distributorId,
        a.slug,
        cliente,
        p1,
        2,
      );
      await patch(adminB, `/orders/${id}`, { notes: 'x' }).expect(404);

      for (const status of [
        OrderStatus.ACCEPTED,
        OrderStatus.ON_THE_WAY,
        OrderStatus.DELIVERED,
        OrderStatus.CANCELLED,
      ]) {
        await ds.getRepository(Order).update({ orderId: id }, { status });
        await patch(adminA, `/orders/${id}`, {
          notes: 'x',
          items: [{ gasCylinderId: p1.gasCylinderId, quantity: 1 }],
        }).expect(409);
      }
      expect(await stockDe(p1.gasCylinderId)).toBe(8);

      const chofer = await usuario(RoleType.DELIVERY, a.distributorId);
      const perfil = await ds
        .getRepository(Delivery)
        .findOneByOrFail({ userId: chofer.user.userId });
      await ds
        .getRepository(Order)
        .update(
          { orderId: id },
          { status: OrderStatus.PENDING, deliveryId: perfil.deliveryId },
        );
      await patch(adminA, `/orders/${id}`, { notes: 'x' }).expect(409);
    }, 60000);

    it('eliminar = cancelar: el pedido queda, cancelado, y el stock vuelve', async () => {
      const { a, adminA, cliente } = await escenario();
      const p1 = await producto(a.distributorId, { stock: 10 });
      const { id } = await pedidoPorApi(
        a.distributorId,
        a.slug,
        cliente,
        p1,
        2,
      );
      await patch(adminA, `/orders/${id}/cancel`, {
        reason: 'duplicado',
      }).expect(200);
      expect(await stockDe(p1.gasCylinderId)).toBe(10);
      const fila = await ds
        .getRepository(Order)
        .findOneByOrFail({ orderId: id });
      expect(fila.status).toBe(OrderStatus.CANCELLED);
      await patch(adminA, `/orders/${id}`, { notes: 'x' }).expect(409);
    }, 60000);
  });

  // ---------- 4. reclamos ----------

  describe('reclamos', () => {
    async function reclamo(distributorId: string, customerId: string) {
      const pedido = await pedidoDirecto(distributorId, customerId);
      return ds.getRepository(Claim).save({
        distributorId,
        orderId: pedido.orderId,
        customerId,
        reason: 'Fuga',
        description: 'Pierde gas',
      } as Partial<Claim>);
    }

    it('GET ficha con pedido y cliente; PATCH sólo mientras está pendiente; rechazar es la baja', async () => {
      const { a, adminA, adminB, cliente } = await escenario();
      const c = await reclamo(a.distributorId, cliente.user.userId);
      const url = `/claims/${c.claimId}`;

      const ficha = await get(adminA, url).expect(200);
      expect(ficha.body).toMatchObject({
        claim_id: c.claimId,
        reason: 'Fuga',
        status: 'pending',
      });
      expect(ficha.body).toHaveProperty('order');
      expect(ficha.body).toHaveProperty('customer');
      await get(adminB, url).expect(404);

      const editado = await patch(adminA, url, {
        description: 'Pierde gas por la válvula',
      }).expect(200);
      expect((editado.body as { description: string }).description).toBe(
        'Pierde gas por la válvula',
      );
      await patch(adminA, url, { orderId: randomUUID() }).expect(400);
      await patch(adminB, url, { reason: 'x' }).expect(404);

      await patch(adminA, `${url}/take`).expect(200);
      await patch(adminA, url, { reason: 'tarde' }).expect(409);

      await patch(adminA, `${url}/resolve`, {
        status: 'rejected',
        resolution: 'Reclamo duplicado',
      }).expect(200);
      const fila = await ds
        .getRepository(Claim)
        .findOneByOrFail({ claimId: c.claimId });
      expect(fila.status).toBe(ClaimStatus.REJECTED);
      expect(fila.reason).toBe('Fuga');
    }, 30000);
  });

  // ---------- 5. incidencias ----------

  describe('incidencias', () => {
    async function incidencia(
      distributorId: string,
      customerId: string,
      reporter: string,
    ) {
      const pedido = await pedidoDirecto(distributorId, customerId);
      return ds.getRepository(Incident).save({
        orderId: pedido.orderId,
        distributorId,
        reportedBy: reporter,
        type: IncidentType.NO_SHOW,
        description: 'No estaba',
        status: IncidentStatus.OPEN,
      } as Partial<Incident>);
    }

    it('GET ficha, PATCH sólo abierta, descartar con motivo es la baja', async () => {
      const { a, adminA, adminB, cliente } = await escenario();
      const chofer = await usuario(RoleType.DELIVERY, a.distributorId);
      const i = await incidencia(
        a.distributorId,
        cliente.user.userId,
        chofer.user.userId,
      );
      const url = `/incidents/${i.incidentId}`;

      const ficha = await get(adminA, url).expect(200);
      expect(ficha.body).toMatchObject({
        status: 'open',
        description: 'No estaba',
      });
      expect(ficha.body).toHaveProperty('order');
      await get(adminB, url).expect(404);

      await patch(adminA, url, { description: 'Nadie atendió' }).expect(200);
      await patch(adminB, url, { description: 'x' }).expect(404);
      await patch(adminA, url, { description: '' }).expect(400);

      await patch(adminA, `${url}/resolve`, {
        status: 'discarded',
      }).expect(400);
      const descartada = await patch(adminA, `${url}/resolve`, {
        status: 'discarded',
        resolutionNote: 'Reporte duplicado',
      }).expect(200);
      expect(descartada.body).toMatchObject({
        status: 'discarded',
        resolution_note: 'Reporte duplicado',
      });
      await patch(adminA, url, { description: 'tarde' }).expect(409);
      await patch(adminA, `${url}/resolve`, { resolutionNote: 'otra' }).expect(
        409,
      );
      expect(await ds.getRepository(Incident).count()).toBe(1);
    }, 30000);

    it('resolver sigue funcionando como antes (sin status)', async () => {
      const { a, adminA, cliente } = await escenario();
      const chofer = await usuario(RoleType.DELIVERY, a.distributorId);
      const i = await incidencia(
        a.distributorId,
        cliente.user.userId,
        chofer.user.userId,
      );
      const r = await patch(adminA, `/incidents/${i.incidentId}/resolve`, {
        resolutionNote: 'Se reprogramó',
      }).expect(200);
      expect(r.body).toMatchObject({ status: 'resolved' });
    }, 30000);
  });

  // ---------- 6. calificaciones ----------

  describe('calificaciones', () => {
    it('ocultar saca la calificación del promedio, el admin la ve marcada; mostrar la devuelve', async () => {
      const { a, adminA, adminB, cliente } = await escenario();
      const chofer = await usuario(RoleType.DELIVERY, a.distributorId);
      const repo = ds.getRepository(Rating);
      const crear = async (stars: number) => {
        const pedido = await pedidoDirecto(
          a.distributorId,
          cliente.user.userId,
        );
        return repo.save({
          orderId: pedido.orderId,
          distributorId: a.distributorId,
          fromUserId: cliente.user.userId,
          toUserId: chofer.user.userId,
          fromRole: RaterRole.CUSTOMER,
          stars,
        } as Partial<Rating>);
      };
      const cinco = await crear(5);
      const una = await crear(1);
      const resumen = async () =>
        json<{ average: number; count: number }>(
          await get(
            adminA,
            `/ratings/user/${chofer.user.userId}/summary`,
          ).expect(200),
        );
      expect(await resumen()).toEqual({ average: 3, count: 2 });

      await get(adminB, `/ratings/${una.ratingId}`).expect(404);
      await patch(adminB, `/ratings/${una.ratingId}/hide`, {
        reason: 'x',
      }).expect(404);
      await patch(adminA, `/ratings/${una.ratingId}/hide`, {}).expect(400);

      const oculta = await patch(adminA, `/ratings/${una.ratingId}/hide`, {
        reason: 'Comentario ofensivo',
      }).expect(200);
      expect(oculta.body).toMatchObject({
        hidden: true,
        hiddenReason: 'Comentario ofensivo',
        hiddenByUserId: adminA.user.userId,
      });
      await patch(adminA, `/ratings/${una.ratingId}/hide`, {
        reason: 'otra',
      }).expect(409);

      expect(await resumen()).toEqual({ average: 5, count: 1 });
      // El admin sigue viéndola, marcada, en la ficha y en el historial.
      const ficha = await get(adminA, `/ratings/${una.ratingId}`).expect(200);
      expect(ficha.body).toMatchObject({ hidden: true });
      const historial = json<Array<{ rating_id: string; hidden: boolean }>>(
        await get(adminA, `/ratings/user/${chofer.user.userId}`).expect(200),
      );
      expect(historial.find((r) => r.rating_id === una.ratingId)?.hidden).toBe(
        true,
      );
      expect(
        historial.find((r) => r.rating_id === cinco.ratingId)?.hidden,
      ).toBe(false);

      await patch(adminA, `/ratings/${una.ratingId}/unhide`, {
        reason: 'error',
      }).expect(200);
      await patch(adminA, `/ratings/${una.ratingId}/unhide`, {
        reason: 'error',
      }).expect(409);
      expect(await resumen()).toEqual({ average: 3, count: 2 });
      expect(await repo.count()).toBe(2);
    }, 30000);
  });

  // ---------- 8. roles ----------

  describe('roles', () => {
    it('DELETE es baja lógica: libera el nombre, no se lista, y con usuarios es 409', async () => {
      const superAdmin = await usuario(RoleType.SUPER_ADMIN, null);
      const crear = (type: string) =>
        http().post('/role').set(superAdmin.headers).send({ type });

      const creado = await crear('qa_pruebas').expect(201);
      const id = json<{ role_id: string }>(creado).role_id;
      await crear('qa_pruebas').expect(409);

      await del(superAdmin, `/role/${id}`).expect(200);
      const lista = json<Array<{ role_id: string }>>(
        await get(superAdmin, '/role').expect(200),
      );
      expect(lista.find((r) => r.role_id === id)).toBeUndefined();
      await get(superAdmin, `/role/${id}`).expect(404);
      const fila = await ds
        .getRepository(Role)
        .findOne({ where: { roleId: id }, withDeleted: true });
      expect(fila?.deletedAt).toBeInstanceOf(Date);

      // El nombre queda libre para un rol nuevo.
      await crear('qa_pruebas').expect(201);

      // Con usuarios no se da de baja.
      const conUsuarios = await ds
        .getRepository(Role)
        .save({ type: 'qa_en_uso' } as Partial<Role>);
      await ds.getRepository(User).save({
        email: 'enuso@splg.local',
        fullName: 'En uso',
        phoneNumber: telefonoDePrueba(),
        roleId: conUsuarios.roleId,
      } as Partial<User>);
      await del(superAdmin, `/role/${conUsuarios.roleId}`).expect(409);
      expect(
        await ds.getRepository(Role).findOneBy({ roleId: conUsuarios.roleId }),
      ).not.toBeNull();
    }, 30000);
  });

  // ---------- 9. administradores ----------

  describe('administradores', () => {
    it('GET /admin/:id trae la ficha con usuario y rol, y respeta el tenant', async () => {
      const { a, adminA, adminB } = await escenario();
      const superAdmin = await usuario(RoleType.SUPER_ADMIN, null);
      const perfil = await ds
        .getRepository(Admin)
        .findOneByOrFail({ userId: adminA.user.userId });

      const r = await get(adminA, `/admin/${perfil.adminId}`).expect(200);
      expect(r.body).toMatchObject({
        admin_id: perfil.adminId,
        distributor_id: a.distributorId,
        user: { email: adminA.user.email },
        role: { type: 'admin' },
      });
      await get(adminB, `/admin/${perfil.adminId}`).expect(404);
      await get(superAdmin, `/admin/${perfil.adminId}`).expect(200);
      await get(adminA, `/admin/${randomUUID()}`).expect(404);
      await get(adminA, '/admin/no-es-uuid').expect(400);
    }, 30000);
  });

  // ---------- 10. ronda 2: concurrencia y validaciones ----------

  describe('ronda 2: carreras y validaciones', () => {
    async function pedido(
      slug: string,
      cliente: Quien,
      prod: GasCylinder,
      cantidad: number,
      extra: object = {},
    ) {
      const address = await direccion(cliente.user.userId);
      const r = await http()
        .post('/orders')
        .set({ ...cliente.headers, 'X-Distributor': slug })
        .send({
          customerId: cliente.user.userId,
          addressId: address.addressId,
          paymentMethod: 'cash',
          items: [
            {
              gasCylinderId: prod.gasCylinderId,
              quantity: cantidad,
              unitPrice: 1000,
            },
          ],
          ...extra,
        });
      return { status: r.status, id: json<{ order_id: string }>(r).order_id };
    }
    const stockDe = async (id: string) =>
      (
        await ds
          .getRepository(GasCylinder)
          .findOneByOrFail({ gasCylinderId: id })
      ).stock;
    const renglones = async (orderId: string) =>
      (
        await ds.getRepository(Order).findOneOrFail({
          where: { orderId },
          relations: ['items'],
        })
      ).items.reduce((acc, i) => acc + i.quantity, 0);

    it('A1: dos PATCH de renglones concurrentes dejan el stock exacto', async () => {
      const { a, adminA, cliente } = await escenario();
      const p = await producto(a.distributorId, { stock: 20 });
      const { id } = await pedido(a.slug, cliente, p, 2);
      expect(await stockDe(p.gasCylinderId)).toBe(18);

      const edicion = (cantidad: number) =>
        patch(adminA, `/orders/${id}`, {
          items: [{ gasCylinderId: p.gasCylinderId, quantity: cantidad }],
        });
      const [r1, r2] = await Promise.all([edicion(5), edicion(3)]);
      expect([r1.status, r2.status]).toEqual([200, 200]);

      const quedan = await renglones(id);
      expect([3, 5]).toContain(quedan);
      expect(await stockDe(p.gasCylinderId)).toBe(20 - quedan);
    }, 60000);

    it('A1: un PATCH y una cancelación concurrentes devuelven el stock exacto', async () => {
      const { a, adminA, cliente } = await escenario();
      const p = await producto(a.distributorId, { stock: 20 });
      const { id } = await pedido(a.slug, cliente, p, 2);

      const [edit, cancel] = await Promise.all([
        patch(adminA, `/orders/${id}`, {
          items: [{ gasCylinderId: p.gasCylinderId, quantity: 6 }],
        }),
        patch(adminA, `/orders/${id}/cancel`, { reason: 'carrera' }),
      ]);
      expect(cancel.status).toBe(200);
      expect([200, 409]).toContain(edit.status);
      const fila = await ds
        .getRepository(Order)
        .findOneByOrFail({ orderId: id });
      expect(fila.status).toBe(OrderStatus.CANCELLED);
      expect(await stockDe(p.gasCylinderId)).toBe(20);
    }, 60000);

    it('seguridad: una cantidad negativa, cero o fraccionaria al crear un pedido es 400 y no toca el stock', async () => {
      const { a, cliente } = await escenario();
      const p = await producto(a.distributorId, { stock: 10 });
      for (const q of [-3, 0, 1.5]) {
        const r = await pedido(a.slug, cliente, p, q);
        expect(r.status).toBe(400);
      }
      expect(await stockDe(p.gasCylinderId)).toBe(10);
      expect(await ds.getRepository(Order).count()).toBe(0);
    }, 60000);

    it('A5: el producto del envase tiene que existir y ser de la distribuidora (404, nunca 500)', async () => {
      const { a, b, adminA } = await escenario();
      const ajeno = await producto(b.distributorId);
      const propio = await producto(a.distributorId);
      const envase = await ds.getRepository(Cylinder).save({
        distributorId: a.distributorId,
        serial: 'SN-A5',
        state: CylinderState.IN_DEPOT,
      } as Partial<Cylinder>);

      for (const gasCylinderId of [ajeno.gasCylinderId, randomUUID()]) {
        await patch(adminA, `/cylinders/${envase.cylinderId}`, {
          gasCylinderId,
        }).expect(404);
        await http()
          .post('/cylinders')
          .set(adminA.headers)
          .send({ serial: `SN-${randomUUID().slice(0, 5)}`, gasCylinderId })
          .expect(404);
      }
      await patch(adminA, `/cylinders/${envase.cylinderId}`, {
        gasCylinderId: propio.gasCylinderId,
      }).expect(200);
    }, 30000);

    it('A4: retire y transition simultáneos: sólo uno se aplica y el historial es coherente', async () => {
      const { a, adminA } = await escenario();
      const envase = await ds.getRepository(Cylinder).save({
        distributorId: a.distributorId,
        serial: 'SN-A4',
        state: CylinderState.IN_DEPOT,
      } as Partial<Cylinder>);
      const [baja, llenado] = await Promise.all([
        patch(adminA, `/cylinders/${envase.cylinderId}/retire`, {
          reason: 'carrera',
        }),
        patch(adminA, `/cylinders/${envase.cylinderId}/transition`, {
          toState: 'filled',
        }),
      ]);
      expect([baja.status, llenado.status].sort()).toEqual([200, 400]);
      const final = await ds
        .getRepository(Cylinder)
        .findOneByOrFail({ cylinderId: envase.cylinderId });
      expect(final.state).toBe(
        baja.status === 200 ? CylinderState.RETIRED : CylinderState.FILLED,
      );
      expect(
        await ds
          .getRepository(CylinderMovement)
          .count({ where: { cylinderId: envase.cylinderId } }),
      ).toBe(1);
    }, 30000);

    it('A8: la capacidad de una franja no baja de lo ya agendado (409)', async () => {
      const { a, adminA, cliente } = await escenario();
      const p = await producto(a.distributorId, { stock: 20 });
      const franja = await ds.getRepository(TimeSlot).save({
        distributorId: a.distributorId,
        name: 'Tarde',
        startTime: '14:00',
        endTime: '18:00',
        capacity: 5,
      } as Partial<TimeSlot>);
      const fecha = new Date(Date.now() + 3 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      for (let i = 0; i < 3; i++) {
        const r = await pedido(a.slug, cliente, p, 1, {
          timeSlotId: franja.timeSlotId,
          scheduledDate: fecha,
        });
        expect(r.status).toBe(201);
      }
      const url = `/time-slot/${franja.timeSlotId}`;
      await patch(adminA, url, { capacity: 2 }).expect(409);
      const ok = await patch(adminA, url, { capacity: 3 }).expect(200);
      expect(json<{ capacity: number }>(ok).capacity).toBe(3);
    }, 60000);

    it('A8: editar la franja de un pedido con fecha pasada exige fecha nueva; timeSlotId null la saca', async () => {
      const { a, adminA, cliente } = await escenario();
      const p = await producto(a.distributorId, { stock: 20 });
      const franja = await ds.getRepository(TimeSlot).save({
        distributorId: a.distributorId,
        name: 'Mañana',
        startTime: '09:00',
        endTime: '13:00',
        capacity: 5,
      } as Partial<TimeSlot>);
      const { id } = await pedido(a.slug, cliente, p, 1);
      await ds
        .getRepository(Order)
        .update(
          { orderId: id },
          { scheduledDate: '2020-01-01', timeSlotId: null },
        );

      const r = await patch(adminA, `/orders/${id}`, {
        timeSlotId: franja.timeSlotId,
      }).expect(400);
      expect(JSON.stringify(r.body)).toContain('ya pasó');

      await patch(adminA, `/orders/${id}`, {
        timeSlotId: franja.timeSlotId,
        scheduledDate: new Date(Date.now() + 2 * 86_400_000)
          .toISOString()
          .slice(0, 10),
      }).expect(200);
      await patch(adminA, `/orders/${id}`, { timeSlotId: null }).expect(200);
      const fila = await ds
        .getRepository(Order)
        .findOneByOrFail({ orderId: id });
      expect(fila.timeSlotId).toBeNull();
    }, 60000);

    it('R3-2: una franja sin fecha se valida igual (ajena o inexistente = 400, nunca fuga ni 500), en edición y en alta', async () => {
      const { a, b, adminA, cliente } = await escenario();
      const p = await producto(a.distributorId, { stock: 20 });
      const ajena = await ds.getRepository(TimeSlot).save({
        distributorId: b.distributorId,
        name: 'Ajena',
        startTime: '09:00',
        endTime: '13:00',
        capacity: 5,
      } as Partial<TimeSlot>);
      const propia = await ds.getRepository(TimeSlot).save({
        distributorId: a.distributorId,
        name: 'Propia',
        startTime: '09:00',
        endTime: '13:00',
        capacity: 5,
      } as Partial<TimeSlot>);
      const { id } = await pedido(a.slug, cliente, p, 1);

      for (const timeSlotId of [ajena.timeSlotId, randomUUID()]) {
        await patch(adminA, `/orders/${id}`, { timeSlotId }).expect(400);
        const alta = await pedido(a.slug, cliente, p, 1, { timeSlotId });
        expect(alta.status).toBe(400);
      }
      const fila = await ds
        .getRepository(Order)
        .findOneByOrFail({ orderId: id });
      expect(fila.timeSlotId).toBeNull();
      expect(await ds.getRepository(Order).count()).toBe(1);
      expect(await stockDe(p.gasCylinderId)).toBe(19);

      await patch(adminA, `/orders/${id}`, {
        timeSlotId: propia.timeSlotId,
      }).expect(200);
    }, 60000);

    it('A6: editar sólo las notas no toca el total ni el recargo guardado', async () => {
      const { a, adminA, cliente } = await escenario();
      const p = await producto(a.distributorId, { stock: 20 });
      const { id } = await pedido(a.slug, cliente, p, 2);
      await ds
        .getRepository(Order)
        .update(
          { orderId: id },
          { totalAmount: 2345, zoneSurchargeAmount: 345 },
        );
      await patch(adminA, `/orders/${id}`, { notes: 'timbre roto' }).expect(
        200,
      );
      const fila = await ds
        .getRepository(Order)
        .findOneByOrFail({ orderId: id });
      expect(Number(fila.totalAmount)).toBe(2345);
      expect(Number(fila.zoneSurchargeAmount)).toBe(345);
    }, 60000);
  });
});
