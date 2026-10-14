/**
 * Cuatro pedidos del panel contra la API con Postgres real: franjas dadas de
 * baja (`includeInactive`), historial de auditoría de un pedido (`orderId`),
 * medio y estado de pago + `editable` en el pedido, y PATCH/DELETE de
 * administradores.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource, IsNull, Not } from 'typeorm';
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
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { Order, PaymentStatus } from '../../src/order/entities/order.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { TimeSlot } from '../../src/time-slot/entities/time-slot.entity';
import { RoleType } from '../../src/common/constants/role-type.enum';
import { Payment } from '../../src/payments/entities/payment.entity';
import {
  LedgerPaymentStatus,
  PaymentGateway,
  PaymentIntegration,
} from '../../src/payments/domain/payment.enums';
import { UsersService } from '../../src/users/users.service';
import { FirebaseAuthPort } from '../../src/firebase/ports/firebase-auth.port';

interface Quien {
  user: User;
  headers: Record<string, string>;
}

interface Entrada {
  entity: string;
  recordId: string;
  distributorId: string | null;
  actionType: { id: number };
  details: {
    field: string;
    oldValue: string | null;
    newValue: string | null;
  }[];
}
interface Pagina {
  data: Entrada[];
  total: number;
}

describe('Pedidos del panel (e2e)', () => {
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
    extra: Partial<User> = {},
  ): Promise<Quien> {
    const s = randomUUID().slice(0, 8);
    const email = `${tipo}.${s}@splg.local`;
    const user = await ds.getRepository(User).save({
      email,
      fullName: `Test ${tipo} ${s}`,
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol(tipo)).roleId,
      ...extra,
    } as Partial<User>);
    if (tipo === RoleType.ADMIN || tipo === RoleType.SUPER_ADMIN) {
      await ds
        .getRepository(Admin)
        .save({ userId: user.userId, distributorId } as Partial<Admin>);
    } else if (tipo === RoleType.CUSTOMER) {
      await ds
        .getRepository(Customer)
        .save({ userId: user.userId } as Partial<Customer>);
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

  async function escenario() {
    const a = await distribuidora();
    const b = await distribuidora();
    const adminA = await usuario(RoleType.ADMIN, a.distributorId);
    const adminB = await usuario(RoleType.ADMIN, b.distributorId);
    const cliente = await usuario(RoleType.CUSTOMER, null);
    const superAdmin = await usuario(RoleType.SUPER_ADMIN, null);
    return { a, b, adminA, adminB, cliente, superAdmin };
  }

  const http = () => request(env.app.getHttpServer());
  const get = (q: Quien, url: string, extra: Record<string, string> = {}) =>
    http().get(url).set(q.headers).set(extra);
  const patch = (q: Quien, url: string, body: object = {}) =>
    http().patch(url).set(q.headers).send(body);
  const del = (q: Quien, url: string) => http().delete(url).set(q.headers);
  const json = <T>(r: request.Response): T => r.body as T;
  const perfilDe = (q: Quien) =>
    ds.getRepository(Admin).findOneByOrFail({ userId: q.user.userId });

  // ---------- 1. franjas dadas de baja ----------

  describe('franjas: includeInactive', () => {
    it('lista sólo las activas por defecto, con includeInactive también las de baja, y reactivar queda auditado', async () => {
      const { a, adminA, adminB, cliente } = await escenario();
      const repo = ds.getRepository(TimeSlot);
      const activa = await repo.save({
        distributorId: a.distributorId,
        name: 'Mañana',
        startTime: '09:00',
        endTime: '13:00',
        capacity: 10,
      } as Partial<TimeSlot>);
      const baja = await repo.save({
        distributorId: a.distributorId,
        name: 'Tarde',
        startTime: '14:00',
        endTime: '18:00',
        capacity: 10,
        isActive: false,
      } as Partial<TimeSlot>);

      const ids = (r: request.Response) =>
        json<{ time_slot_id: string }[]>(r).map((s) => s.time_slot_id);

      expect(ids(await get(adminA, '/time-slot').expect(200))).toEqual([
        activa.timeSlotId,
      ]);
      expect(
        ids(await get(adminA, '/time-slot?includeInactive=false').expect(200)),
      ).toEqual([activa.timeSlotId]);
      const todas = await get(adminA, '/time-slot?includeInactive=true').expect(
        200,
      );
      expect(ids(todas).sort()).toEqual(
        [activa.timeSlotId, baja.timeSlotId].sort(),
      );
      expect(
        json<{ time_slot_id: string; isActive: boolean }[]>(todas).find(
          (s) => s.time_slot_id === baja.timeSlotId,
        )?.isActive,
      ).toBe(false);

      // otra distribuidora no ve las de A; un valor inválido es 400; un cliente 403
      expect(
        json<unknown[]>(
          await get(adminB, '/time-slot?includeInactive=true').expect(200),
        ),
      ).toHaveLength(0);
      await get(adminA, '/time-slot?includeInactive=quizas').expect(400);
      await get(cliente, '/time-slot?includeInactive=true').expect(403);

      // reactivar con PATCH funciona, aparece en el listado por defecto y deja asiento
      const r = await patch(adminA, `/time-slot/${baja.timeSlotId}`, {
        isActive: true,
      }).expect(200);
      expect(json<{ isActive: boolean }>(r).isActive).toBe(true);
      expect(ids(await get(adminA, '/time-slot').expect(200)).sort()).toEqual(
        [activa.timeSlotId, baja.timeSlotId].sort(),
      );
      const asientos = json<Pagina>(
        await get(
          adminA,
          `/audit/entries?entity=TimeSlot&recordId=${baja.timeSlotId}`,
        ).expect(200),
      );
      const reactivacion = asientos.data.find((e) =>
        e.details.some(
          (d) =>
            d.field === 'isActive' &&
            d.oldValue === 'false' &&
            d.newValue === 'true',
        ),
      );
      expect(reactivacion).toBeDefined();
      expect(reactivacion?.actionType.id).toBe(2);
    }, 30000);
  });

  describe('franjas: ?distributor', () => {
    it('un admin queda en su distribuidora aunque pida otra; el super admin sí elige', async () => {
      const { a, b, adminA, superAdmin } = await escenario();
      const repo = ds.getRepository(TimeSlot);
      const deA = await repo.save({
        distributorId: a.distributorId,
        name: 'A',
        startTime: '09:00',
        endTime: '10:00',
        capacity: 5,
      } as Partial<TimeSlot>);
      const deB = await repo.save({
        distributorId: b.distributorId,
        name: 'B',
        startTime: '09:00',
        endTime: '10:00',
        capacity: 5,
      } as Partial<TimeSlot>);
      const ids = (r: request.Response) =>
        json<{ time_slot_id: string }[]>(r).map((x) => x.time_slot_id);
      expect(
        ids(await get(adminA, `/time-slot?distributor=${b.slug}`).expect(200)),
      ).toEqual([deA.timeSlotId]);
      expect(
        ids(
          await get(superAdmin, `/time-slot?distributor=${b.slug}`).expect(200),
        ),
      ).toEqual([deB.timeSlotId]);
    }, 30000);
  });

  // ---------- 2 y 3. pedido: auditoría, pago y editable ----------

  describe('pedido', () => {
    async function pedidoPorApi(
      slug: string,
      cliente: Quien,
      prod: GasCylinder,
      extra: object = {},
    ) {
      const address = await ds.getRepository(UserAddress).save({
        userId: cliente.user.userId,
        street: 'Av. Test 123',
        city: 'CABA',
        latitude: '-34.6037',
        longitude: '-58.3816',
      } as Partial<UserAddress>);
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
              quantity: 2,
              unitPrice: 1000,
            },
          ],
          ...extra,
        })
        .expect(201);
      return json<{ order_id: string }>(r).order_id;
    }

    async function producto(distributorId: string): Promise<GasCylinder> {
      return ds.getRepository(GasCylinder).save({
        type: '10kg',
        price: 1000,
        stock: 20,
        weight: 10,
        isActive: true,
        distributorId,
      } as Partial<GasCylinder>);
    }

    it('GET /audit/entries?orderId trae el pedido, sus renglones y su historia, sin cruzar distribuidoras', async () => {
      const { a, b, adminA, adminB, cliente, superAdmin } = await escenario();
      const p = await producto(a.distributorId);
      const id = await pedidoPorApi(a.slug, cliente, p);
      const otro = await pedidoPorApi(a.slug, cliente, p);
      // editar renglones deja asientos nuevos de los renglones del mismo pedido
      await patch(adminA, `/orders/${id}`, {
        items: [{ gasCylinderId: p.gasCylinderId, quantity: 3 }],
      }).expect(200);

      const r = json<Pagina>(
        await get(adminA, `/audit/entries?orderId=${id}`).expect(200),
      );
      const entidades = new Set(r.data.map((e) => e.entity));
      expect(entidades).toEqual(new Set(['Order', 'OrderItem']));
      expect(
        r.data.filter((e) => e.entity === 'Order').map((e) => e.recordId),
      ).toEqual(
        Array(r.data.filter((e) => e.entity === 'Order').length).fill(id),
      );
      for (const e of r.data.filter((x) => x.entity === 'OrderItem')) {
        const d = e.details.find((x) => x.field === 'orderId');
        expect(d?.newValue ?? d?.oldValue).toBe(id);
      }
      expect(
        r.data.filter((e) => e.entity === 'OrderItem').length,
      ).toBeGreaterThan(1);
      // el historial del renglón está completo: alta, y la baja física del
      // renglón que la edición reemplazó, con su orderId en el valor anterior
      const renglones = r.data.filter((e) => e.entity === 'OrderItem');
      expect(renglones.filter((e) => e.actionType.id === 1).length).toBe(2);
      const baja = renglones.filter((e) => e.actionType.id === 5);
      expect(baja).toHaveLength(1);
      expect(baja[0].details.find((d) => d.field === 'orderId')).toMatchObject({
        oldValue: id,
        newValue: null,
      });
      expect(
        baja[0].details.find((d) => d.field === 'quantity')?.oldValue,
      ).toBe('2');
      expect(baja[0].distributorId).toBe(a.distributorId);

      // el otro pedido no se mezcla
      expect(
        r.data.some((e) => e.details.some((d) => d.newValue === otro)),
      ).toBe(false);
      expect(r.total).toBe(r.data.length);

      // filtros combinados y paginación existentes
      const soloRenglones = json<Pagina>(
        await get(
          adminA,
          `/audit/entries?orderId=${id}&entity=OrderItem`,
        ).expect(200),
      );
      expect(soloRenglones.data.every((e) => e.entity === 'OrderItem')).toBe(
        true,
      );
      const pagina1 = json<Pagina>(
        await get(adminA, `/audit/entries?orderId=${id}&limit=1&page=1`).expect(
          200,
        ),
      );
      expect(pagina1.data).toHaveLength(1);
      expect(pagina1.total).toBe(r.total);

      // otra distribuidora: vacío; super admin: todo, o lo de la que elige
      const ajena = json<Pagina>(
        await get(adminB, `/audit/entries?orderId=${id}`).expect(200),
      );
      expect(ajena).toEqual({ data: [], total: 0 });
      const sa = json<Pagina>(
        await get(superAdmin, `/audit/entries?orderId=${id}`).expect(200),
      );
      expect(sa.total).toBe(r.total);
      const saComoB = json<Pagina>(
        await get(superAdmin, `/audit/entries?orderId=${id}`, {
          'X-Distributor': b.slug,
        }).expect(200),
      );
      expect(saComoB.total).toBe(0);

      await get(adminA, '/audit/entries?orderId=no-es-uuid').expect(400);
      await get(cliente, `/audit/entries?orderId=${id}`).expect(403);
    }, 60000);

    it('el historial del pedido incluye el alta y las modificaciones de un pago (como el webhook), y acepta el orderId en mayúsculas', async () => {
      const { a, adminA, adminB, cliente } = await escenario();
      const p = await producto(a.distributorId);
      const id = await pedidoPorApi(a.slug, cliente, p);
      const pagos = ds.getRepository(Payment);
      const pago = await pagos.save({
        orderId: id,
        distributorId: a.distributorId,
        gateway: PaymentGateway.MERCADOPAGO,
        integration: PaymentIntegration.CHECKOUT_PRO,
        externalReference: id,
        amount: 2000,
      } as Partial<Payment>);
      // igual que PaymentsService.updateLedger: se relee y se guarda
      const ledger = await pagos.findOneByOrFail({ paymentId: pago.paymentId });
      ledger.gatewayPaymentId = 'mp-123';
      ledger.status = LedgerPaymentStatus.APPROVED;
      await pagos.save(ledger);

      const r = json<Pagina>(
        await get(adminA, `/audit/entries?orderId=${id}&entity=Payment`).expect(
          200,
        ),
      );
      expect(r.data.map((e) => e.actionType.id).sort()).toEqual([1, 2]);
      const modificacion = r.data.find((e) => e.actionType.id === 2);
      expect(modificacion?.recordId).toBe(pago.paymentId);
      expect(
        modificacion?.details.find((d) => d.field === 'orderId'),
      ).toMatchObject({ oldValue: id, newValue: id });
      expect(
        modificacion?.details.find((d) => d.field === 'status'),
      ).toMatchObject({ oldValue: 'pending', newValue: 'approved' });

      const mayus = json<Pagina>(
        await get(
          adminA,
          `/audit/entries?orderId=${id.toUpperCase()}&entity=Payment`,
        ).expect(200),
      );
      expect(mayus.total).toBe(2);
      expect(
        json<Pagina>(
          await get(adminB, `/audit/entries?orderId=${id}`).expect(200),
        ).total,
      ).toBe(0);
    }, 60000);

    it('la entrega manual del admin exige un motivo y lo deja en el historial de estados y en la auditoría', async () => {
      const { a, b, adminA, adminB, cliente } = await escenario();
      const p = await producto(a.distributorId);
      const id = await pedidoPorApi(a.slug, cliente, p);
      await ds.query(
        `UPDATE "order" SET status = 'on_the_way' WHERE order_id = $1`,
        [id],
      );
      const entregar = (q: Quien, body: object) =>
        patch(q, `/orders/${id}/status`, body).set('X-Distributor', a.slug);

      // sin motivo, vacío o demasiado corto: 400 y el pedido no se mueve
      for (const body of [
        { status: 'delivered' },
        { status: 'delivered', reason: '   ' },
        { status: 'delivered', reason: 'corto' },
      ]) {
        const r = await entregar(adminA, body).expect(400);
        expect(JSON.stringify(r.body)).toMatch(/motivo/);
      }
      const intacto = await ds
        .getRepository(Order)
        .findOneByOrFail({ orderId: id });
      expect(intacto.status).toBe('on_the_way');

      // otra distribuidora no lo toca (404)
      await patch(adminB, `/orders/${id}/status`, {
        status: 'delivered',
        reason: 'El cliente no tiene celular',
      })
        .set('X-Distributor', b.slug)
        .expect(404);

      await entregar(adminA, {
        status: 'delivered',
        reason: '  El cliente no tiene celular  ',
      }).expect(200);
      const entregado = await ds
        .getRepository(Order)
        .findOneByOrFail({ orderId: id });
      expect(entregado.status).toBe('delivered');

      const historial = await ds.query<
        Array<{
          from_status: string;
          to_status: string;
          reason: string;
          changed_by_user_id: string;
        }>
      >(
        `SELECT from_status, to_status, reason, changed_by_user_id FROM order_status_history WHERE order_id = $1 AND to_status = 'delivered'`,
        [id],
      );
      expect(historial).toEqual([
        {
          from_status: 'on_the_way',
          to_status: 'delivered',
          reason: 'El cliente no tiene celular',
          changed_by_user_id: adminA.user.userId,
        },
      ]);

      const auditoria = json<Pagina>(
        await get(adminA, `/audit/entries?orderId=${id}&entity=Order`).expect(
          200,
        ),
      );
      const motivo = auditoria.data
        .flatMap((e) => e.details)
        .find((d) => d.field === 'manualDeliveryReason');
      expect(motivo?.newValue).toBe('El cliente no tiene celular');
    });

    it('la entrega por QR: el admin también necesita motivo (queda en historial y auditoría); el cliente no', async () => {
      const { a, adminA, cliente } = await escenario();
      const p = await producto(a.distributorId);
      const delAdmin = await pedidoPorApi(a.slug, cliente, p);
      const delCliente = await pedidoPorApi(a.slug, cliente, p);
      await ds.query(
        `UPDATE "order" SET status = 'on_the_way', "deliveryCode" = 'QRCODE1234' WHERE order_id = ANY($1)`,
        [[delAdmin, delCliente]],
      );
      const confirmar = (q: Quien, id: string, body: object) =>
        http()
          .post(`/orders/${id}/confirm-delivery`)
          .set(q.headers)
          .set('X-Distributor', a.slug)
          .send(body);

      for (const reason of [undefined, '', 'corto']) {
        const r = await confirmar(adminA, delAdmin, {
          code: 'QRCODE1234',
          reason,
        }).expect(400);
        expect(JSON.stringify(r.body)).toMatch(/motivo/);
      }
      expect(
        (await ds.getRepository(Order).findOneByOrFail({ orderId: delAdmin }))
          .status,
      ).toBe('on_the_way');

      await confirmar(adminA, delAdmin, {
        code: 'QRCODE1234',
        reason: 'Entrega asistida por teléfono',
      }).expect(201);
      const historial = await ds.query<
        Array<{ reason: string; changed_by_user_id: string }>
      >(
        `SELECT reason, changed_by_user_id FROM order_status_history WHERE order_id = $1 AND to_status = 'delivered'`,
        [delAdmin],
      );
      expect(historial).toEqual([
        {
          reason: 'Entrega asistida por teléfono',
          changed_by_user_id: adminA.user.userId,
        },
      ]);
      const auditoria = json<Pagina>(
        await get(
          adminA,
          `/audit/entries?orderId=${delAdmin}&entity=Order`,
        ).expect(200),
      );
      expect(
        auditoria.data
          .flatMap((e) => e.details)
          .find((d) => d.field === 'manualDeliveryReason')?.newValue,
      ).toBe('Entrega asistida por teléfono');

      // el cliente escanea sin motivo y no deja asiento manual
      await confirmar(cliente, delCliente, { code: 'QRCODE1234' }).expect(201);
      expect(
        await ds.query(
          `SELECT 1 FROM order_status_history WHERE order_id = $1 AND reason IS NOT NULL`,
          [delCliente],
        ),
      ).toEqual([]);
      expect(
        (await ds.getRepository(Order).findOneByOrFail({ orderId: delCliente }))
          .status,
      ).toBe('delivered');
    });

    it('el pedido expone paymentMethodDetail, paymentStatus y editable con la regla de PATCH', async () => {
      const { a, adminA, cliente } = await escenario();
      const p = await producto(a.distributorId);
      const efectivo = await pedidoPorApi(a.slug, cliente, p);
      const transfer = await pedidoPorApi(a.slug, cliente, p, {
        paymentMethod: 'transfer',
      });

      for (const [id, detalle, agrupado] of [
        [efectivo, 'cash', 'cash'],
        [transfer, 'transfer', 'online'],
      ] as const) {
        const o = json<Record<string, unknown>>(
          await get(adminA, `/orders/${id}`).expect(200),
        );
        expect(o).toMatchObject({
          payment_method: agrupado,
          paymentMethodDetail: detalle,
          paymentStatus: 'pending',
          editable: true,
        });
        await patch(adminA, `/orders/${id}`, { notes: 'x' }).expect(200);
      }

      // pago ya cobrado: el DTO dice no editable y PATCH responde 409
      await ds
        .getRepository(Order)
        .update({ orderId: transfer }, { paymentStatus: PaymentStatus.PAID });
      const cobrado = json<Record<string, unknown>>(
        await get(adminA, `/orders/${transfer}`).expect(200),
      );
      expect(cobrado).toMatchObject({
        paymentMethodDetail: 'transfer',
        paymentStatus: 'paid',
        editable: false,
      });
      await patch(adminA, `/orders/${transfer}`, { notes: 'y' }).expect(409);

      // cancelado: tampoco
      await patch(adminA, `/orders/${efectivo}/cancel`, {
        reason: 'prueba',
      }).expect(200);
      expect(
        json<{ editable: boolean }>(
          await get(adminA, `/orders/${efectivo}`).expect(200),
        ).editable,
      ).toBe(false);
      await patch(adminA, `/orders/${efectivo}`, { notes: 'z' }).expect(409);
    }, 60000);
  });

  // ---------- 4. administradores ----------

  describe('administradores: PATCH y DELETE', () => {
    it('PATCH edita nombre y teléfono, valida y respeta permisos y tenant', async () => {
      const { a, adminA, adminB, superAdmin } = await escenario();
      const colega = await usuario(RoleType.ADMIN, a.distributorId);
      const pColega = await perfilDe(colega);
      const url = `/admin/${pColega.adminId}`;

      const r = await patch(adminA, url, {
        fullName: 'Nombre Nuevo',
        phoneNumber: '+5493764111222',
      }).expect(200);
      expect(r.body).toMatchObject({
        admin_id: pColega.adminId,
        user: { full_name: 'Nombre Nuevo' },
      });
      const guardado = await ds
        .getRepository(User)
        .findOneByOrFail({ userId: colega.user.userId });
      expect(guardado).toMatchObject({
        fullName: 'Nombre Nuevo',
        phoneNumber: '+5493764111222',
        email: colega.user.email,
      });

      await patch(adminA, url, { email: 'otro@splg.local' }).expect(400);
      await patch(adminA, url, { phoneNumber: '123' }).expect(400);
      await patch(adminA, url, { fullName: 'x' }).expect(400);
      // teléfono en uso por otra cuenta
      await patch(adminA, url, { phoneNumber: adminA.user.phoneNumber }).expect(
        409,
      );
      await patch(adminB, url, { fullName: 'robo' }).expect(404);
      await patch(adminA, `/admin/${randomUUID()}`, {
        fullName: 'Nadie',
      }).expect(404);

      // nunca a sí mismo ni a un super admin
      const propio = await perfilDe(adminA);
      await patch(adminA, `/admin/${propio.adminId}`, {
        fullName: 'Yo mismo',
      }).expect(403);
      const pSuper = await perfilDe(superAdmin);
      await patch(adminA, `/admin/${pSuper.adminId}`, {
        fullName: 'Intruso',
      }).expect(404);

      // el super admin llega a cualquiera
      // Sobre el personal de una distribuidora, el super admin dice en cuál actúa.
      await patch(superAdmin, url, { fullName: 'Por el super' }).expect(400);
      await patch(superAdmin, url, { fullName: 'Por el super' })
        .set('X-Distributor', a.slug)
        .expect(200);
    }, 60000);

    it('DELETE es baja lógica: deslogea, deshabilita Firebase, conserva la fila y sale del listado', async () => {
      const { a, adminA, adminB, superAdmin } = await escenario();
      const colega = await usuario(RoleType.ADMIN, a.distributorId, {
        firebaseUid: 'uid-colega',
      } as Partial<User>);
      const pColega = await perfilDe(colega);
      const updateUser = jest
        .spyOn(env.app.get(FirebaseAuthPort), 'updateUser')
        .mockResolvedValue(undefined as never);

      await del(adminB, `/admin/${pColega.adminId}`).expect(404);
      const propio = await perfilDe(adminA);
      await del(adminA, `/admin/${propio.adminId}`).expect(403);
      await del(
        adminA,
        `/admin/${(await perfilDe(superAdmin)).adminId}`,
      ).expect(404);

      await del(adminA, `/admin/${pColega.adminId}`).expect(200);
      expect(updateUser).toHaveBeenCalledWith('uid-colega', { disabled: true });
      const fila = await ds.getRepository(User).findOne({
        where: { userId: colega.user.userId, deletedAt: Not(IsNull()) },
        withDeleted: true,
      });
      expect(fila).not.toBeNull();
      expect(
        await ds
          .getRepository(Admin)
          .count({ where: { adminId: pColega.adminId } }),
      ).toBe(1);

      // ya no aparece ni entra
      await get(adminA, `/admin/${pColega.adminId}`).expect(404);
      const lista = json<{ admin_id: string }[]>(
        await get(adminA, '/admin').expect(200),
      );
      expect(lista.map((x) => x.admin_id)).not.toContain(pColega.adminId);
      await get(colega, '/admin').expect(401);
      await del(adminA, `/admin/${pColega.adminId}`).expect(404);
      void a;
    }, 60000);

    it('no se puede dar de baja al último administrador activo de la distribuidora (409), salvo que ya no cuente', async () => {
      const { a, adminA, superAdmin } = await escenario();
      const segundo = await usuario(RoleType.ADMIN, a.distributorId);
      const pA = await perfilDe(adminA);
      const pSegundo = await perfilDe(segundo);

      // el super admin da de baja al segundo; el primero queda solo
      await del(superAdmin, `/admin/${pSegundo.adminId}`)
        .set('X-Distributor', a.slug)
        .expect(200);
      const r = await del(superAdmin, `/admin/${pA.adminId}`)
        .set('X-Distributor', a.slug)
        .expect(409);
      expect(json<{ message: string }>(r).message).toMatch(/último/);
      expect(
        await ds
          .getRepository(User)
          .count({ where: { userId: adminA.user.userId } }),
      ).toBe(1);

      // con otro admin activo vuelve a ser posible; uno bloqueado no cuenta
      const tercero = await usuario(RoleType.ADMIN, a.distributorId, {
        blocked: true,
      } as Partial<User>);
      await del(superAdmin, `/admin/${pA.adminId}`)
        .set('X-Distributor', a.slug)
        .expect(409);
      await ds
        .getRepository(User)
        .update({ userId: tercero.user.userId }, { blocked: false });
      await del(superAdmin, `/admin/${pA.adminId}`)
        .set('X-Distributor', a.slug)
        .expect(200);
    }, 60000);

    it('dos bajas simultáneas de los dos últimos administradores: una sola pasa', async () => {
      const { a, adminA, superAdmin } = await escenario();
      const segundo = await usuario(RoleType.ADMIN, a.distributorId);
      const pA = await perfilDe(adminA);
      const pS = await perfilDe(segundo);
      const [x, y] = await Promise.all([
        del(superAdmin, `/admin/${pA.adminId}`).set('X-Distributor', a.slug),
        del(superAdmin, `/admin/${pS.adminId}`).set('X-Distributor', a.slug),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
    }, 60000);
    it('super admin: no se da de baja a sí mismo (403, por /admin y por /users) y no se baja al último (409)', async () => {
      const { superAdmin } = await escenario();
      const otro = await usuario(RoleType.SUPER_ADMIN, null);
      const pSuper = await perfilDe(superAdmin);
      const pOtro = await perfilDe(otro);

      await del(superAdmin, `/admin/${pSuper.adminId}`).expect(403);
      await del(superAdmin, `/users/${superAdmin.user.userId}`).expect(403);

      // con dos, uno puede dar de baja al otro; el que queda es el último
      await del(superAdmin, `/admin/${pOtro.adminId}`).expect(200);
      const r = await env.app
        .get(UsersService)
        .remove(superAdmin.user.userId)
        .then(
          () => 200,
          (e: { status?: number }) => e.status,
        );
      expect(r).toBe(409);
      expect(
        await ds
          .getRepository(User)
          .count({ where: { userId: superAdmin.user.userId } }),
      ).toBe(1);
    }, 60000);

    it('dos super admin que se dan de baja entre sí a la vez: uno solo lo logra', async () => {
      const { superAdmin } = await escenario();
      const otro = await usuario(RoleType.SUPER_ADMIN, null);
      const [x, y] = await Promise.all([
        del(superAdmin, `/admin/${(await perfilDe(otro)).adminId}`),
        del(otro, `/admin/${(await perfilDe(superAdmin)).adminId}`),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
    }, 60000);

    it('por DELETE /users/:id tampoco se salta la regla del último admin', async () => {
      const { a, adminA, superAdmin } = await escenario();
      await del(superAdmin, `/users/${adminA.user.userId}`)
        .set('X-Distributor', a.slug)
        .expect(409);
      expect(
        await ds
          .getRepository(User)
          .count({ where: { userId: adminA.user.userId } }),
      ).toBe(1);
    }, 60000);
  });

  describe('bloqueo y auto-baja', () => {
    it('la auto-baja y el auto-bloqueo con el UUID en mayúsculas también dan 403', async () => {
      const { superAdmin } = await escenario();
      const mio = superAdmin.user.userId.toUpperCase();
      await del(superAdmin, `/users/${mio}`).expect(403);
      await patch(superAdmin, `/users/${mio}/block`, { block: true }).expect(
        403,
      );
      await patch(superAdmin, `/users/${mio}`, { blocked: true }).expect(403);
      expect(
        (
          await ds
            .getRepository(User)
            .findOneByOrFail({ userId: superAdmin.user.userId })
        ).blocked,
      ).toBe(false);
    }, 30000);

    it('bloquear al último admin activo es 409 por /block y por PATCH /users; con otro activo se puede', async () => {
      const { a, adminA, superAdmin } = await escenario();
      const bloqueado = () =>
        ds
          .getRepository(User)
          .findOneByOrFail({ userId: adminA.user.userId })
          .then((u) => u.blocked);
      await patch(superAdmin, `/users/${adminA.user.userId}/block`, {
        block: true,
      })
        .set('X-Distributor', a.slug)
        .expect(409);
      await patch(superAdmin, `/users/${adminA.user.userId}`, { blocked: true })
        .set('X-Distributor', a.slug)
        .expect(409);
      expect(await bloqueado()).toBe(false);

      const segundo = await usuario(RoleType.ADMIN, a.distributorId);
      await patch(superAdmin, `/users/${adminA.user.userId}/block`, {
        block: true,
      })
        .set('X-Distributor', a.slug)
        .expect(200);
      expect(await bloqueado()).toBe(true);
      // y ahora el segundo es el último activo: ni baja ni bloqueo
      await patch(superAdmin, `/users/${segundo.user.userId}/block`, {
        block: true,
      })
        .set('X-Distributor', a.slug)
        .expect(409);
      await del(superAdmin, `/users/${segundo.user.userId}`)
        .set('X-Distributor', a.slug)
        .expect(409);
    }, 60000);

    it('bloquear al último super admin es 409; dos bloqueos cruzados a la vez: uno solo pasa', async () => {
      const { superAdmin } = await escenario();
      const otro = await usuario(RoleType.SUPER_ADMIN, null);
      const [x, y] = await Promise.all([
        patch(superAdmin, `/users/${otro.user.userId}/block`, { block: true }),
        patch(otro, `/users/${superAdmin.user.userId}/block`, { block: true }),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
    }, 60000);
  });

  it('los índices parciales de la consulta por orderId existen', async () => {
    const filas = await ds.query<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'audit_detail' AND indexname LIKE 'IDX_audit_detail_order_%'`,
    );
    expect(filas.map((f) => f.indexname).sort()).toEqual([
      'IDX_audit_detail_order_anterior',
      'IDX_audit_detail_order_nuevo',
    ]);
  });
});
