/**
 * C-11, CU-132 a CU-135 contra la API con Postgres y Redis reales:
 *  - Revisión periódica de un envase (alta, validaciones, rechazo, fuera del depósito).
 *  - Vigencia por id y por serial, con el historial.
 *  - Listado de próximos a vencer, con sus tres grupos.
 *  - Bloqueo de la asignación a un pedido: todo o nada, 409 con la lista de seriales,
 *    el envase sin fecha pasa, el listado filtra por tipo y vigencia.
 *  - Aislamiento: lo de otra distribuidora responde 404 y no aparece en los listados.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { conIdempotencia } from './setup/con-idempotencia';
import { TestEnv, createTestApp, truncateAllTables } from './setup/test-env';
import {
  diaArgentino,
  finDelDia,
  inicioDelDia,
} from '../../src/cylinder/domain/dia-calendario';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Admin } from '../../src/admin/entities/admin.entity';
import { RoleType } from '../../src/common/constants/role-type.enum';
import {
  Cylinder,
  CylinderState,
} from '../../src/cylinder/entities/cylinder.entity';
import { CylinderInspection } from '../../src/cylinder/entities/cylinder-inspection.entity';
import { CylinderMovement } from '../../src/cylinder/entities/cylinder-movement.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { Role } from '../../src/role/entities/role.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { User } from '../../src/users/entities/user.entity';

const DIA = 86400000;
const enDias = (n: number) => new Date(Date.now() + n * DIA).toISOString();
/** Día calendario argentino `YYYY-MM-DD` dentro de `n` días. */
const dia = (n: number) => diaArgentino(new Date(Date.now() + n * DIA));

interface Vigencia {
  cylinderId: string;
  serial: string;
  status: 'valid' | 'expired' | 'unverified';
  daysRemaining: number | null;
  expiresAt: string | null;
  lastInspectionAt: string | null;
  withdrawalPending: boolean;
  inspections: Array<{ result: string; nextDueAt: string | null }>;
}
interface Vencimientos {
  windowDays: number;
  expired: Array<{ serial: string }>;
  expiring: Array<{ serial: string; daysRemaining: number }>;
  unverified: Array<{ serial: string }>;
}
interface Rechazo {
  statusCode: number;
  code?: string;
  serials?: string[];
  message: string;
}

describe('Vigencia de envases (CU-132 a CU-135, e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;

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

  const servidor = () => env.app.getHttpServer();
  const cuerpo = <T>(r: request.Response): T => r.body as T;

  const rol = async (type: RoleType) =>
    (await ds.getRepository(Role).findOneBy({ type })) ??
    ds.getRepository(Role).save({ type } as Partial<Role>);

  const distribuidora = () =>
    ds.getRepository(Distributor).save({
      name: 'Distribuidora Test',
      slug: `test-${randomUUID()}`,
    } as Partial<Distributor>);

  async function adminDe(distributorId: string) {
    const r = await rol(RoleType.ADMIN);
    const user = await ds.getRepository(User).save({
      email: `admin.${randomUUID().slice(0, 8)}@test.local`,
      fullName: 'Admin',
      roleId: r.roleId,
    } as Partial<User>);
    await ds
      .getRepository(Admin)
      .save({ userId: user.userId, distributorId } as Partial<Admin>);
    return user;
  }

  const como = (quien: User, req: request.Test): request.Test =>
    req
      .set('Authorization', `Bearer ${quien.email}`)
      .set('X-Client-Source', 'panel-app');

  const get = (quien: User, url: string) =>
    como(quien, request(servidor()).get(url));
  const post = (quien: User, url: string) =>
    como(quien, conIdempotencia(servidor()).post(url));

  const envase = (
    distributorId: string,
    serial: string,
    over: Partial<Cylinder> = {},
  ) =>
    ds.getRepository(Cylinder).save({
      distributorId,
      serial,
      state: CylinderState.FILLED,
      ...over,
    } as Partial<Cylinder>);

  async function cliente(): Promise<User> {
    const r = await rol(RoleType.CUSTOMER);
    const user = await ds.getRepository(User).save({
      email: `cli.${randomUUID().slice(0, 8)}@test.local`,
      fullName: 'Cliente',
      roleId: r.roleId,
    } as Partial<User>);
    await ds
      .getRepository(Customer)
      .save({ userId: user.userId } as Partial<Customer>);
    return user;
  }

  async function pedido(distributorId: string): Promise<Order> {
    const user = await cliente();
    const address = await ds.getRepository(UserAddress).save({
      userId: user.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>);
    return ds.getRepository(Order).save({
      customerId: user.userId,
      distributorId,
      addressId: address.addressId,
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.CASH,
      totalAmount: 1000,
      subtotalItems: 1000,
    } as Partial<Order>);
  }

  const estadoDe = async (id: string) =>
    (await ds.getRepository(Cylinder).findOneByOrFail({ cylinderId: id }))
      .state;

  describe('POST /cylinders/:id/inspections (CU-132)', () => {
    it('guarda la revisión, copia las fechas a la ficha y la vigencia las devuelve', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const c = await envase(d.distributorId, 'SN-1');
      const inspectedAt = dia(-2);
      const nextDueAt = dia(365);

      const creada = await post(admin, `/cylinders/${c.cylinderId}/inspections`)
        .send({ inspectedAt, result: 'approved', nextDueAt, notes: 'ok' })
        .expect(201);
      const v = cuerpo<Vigencia>(creada);
      expect(v.status).toBe('valid');
      // Vale hasta el final del día de vencimiento, hora de Buenos Aires.
      expect(v.expiresAt).toBe(finDelDia(nextDueAt).toISOString());
      expect(v.lastInspectionAt).toBe(inicioDelDia(inspectedAt).toISOString());
      expect(v.inspections).toHaveLength(1);

      const ficha = await ds
        .getRepository(Cylinder)
        .findOneByOrFail({ cylinderId: c.cylinderId });
      expect(ficha.expiresAt?.toISOString()).toBe(
        finDelDia(nextDueAt).toISOString(),
      );
      expect(
        await ds
          .getRepository(CylinderInspection)
          .countBy({ cylinderId: c.cylinderId }),
      ).toBe(1);
    });

    it('un rechazo deja el vencimiento en la fecha de la revisión: el envase queda vencido', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const c = await envase(d.distributorId, 'SN-1', {
        expiresAt: new Date(enDias(200)),
      });
      const inspectedAt = dia(-1);

      const r = await post(admin, `/cylinders/${c.cylinderId}/inspections`)
        .send({ inspectedAt, result: 'rejected', nextDueAt: dia(400) })
        .expect(201);

      const v = cuerpo<Vigencia>(r);
      expect(v.status).toBe('expired');
      expect(v.expiresAt).toBe(inicioDelDia(inspectedAt).toISOString());
      expect(v.inspections[0].nextDueAt).toBeNull();
    });

    it('rechazado y en poder de un cliente: sigue con el cliente y queda marcado para retirar', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const c = await envase(d.distributorId, 'SN-1', {
        state: CylinderState.WITH_CUSTOMER,
        currentCustomerId: (await cliente()).userId,
      });

      const r = await post(admin, `/cylinders/${c.cylinderId}/inspections`)
        .send({ inspectedAt: dia(-1), result: 'rejected' })
        .expect(201);

      expect(cuerpo<Vigencia>(r).withdrawalPending).toBe(true);
      expect(await estadoDe(c.cylinderId)).toBe(CylinderState.WITH_CUSTOMER);
      const movs = await ds
        .getRepository(CylinderMovement)
        .findBy({ cylinderId: c.cylinderId });
      expect(movs.map((m) => m.note)).toEqual([
        expect.stringContaining('retirar') as string,
      ]);
    });

    it('una revisión vieja entra al historial y no pisa la ficha', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const c = await envase(d.distributorId, 'SN-1');
      const url = `/cylinders/${c.cylinderId}/inspections`;
      const vigente = dia(300);
      await post(admin, url)
        .send({
          inspectedAt: dia(-10),
          result: 'approved',
          nextDueAt: vigente,
        })
        .expect(201);

      const r = await post(admin, url)
        .send({
          inspectedAt: dia(-500),
          result: 'approved',
          nextDueAt: dia(-135),
        })
        .expect(201);

      const v = cuerpo<Vigencia>(r);
      expect(v.inspections).toHaveLength(2);
      expect(v.expiresAt).toBe(finDelDia(vigente).toISOString());
    });

    it('valida: fecha futura, vencimiento faltante o no posterior, resultado inválido', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const c = await envase(d.distributorId, 'SN-1');
      const url = `/cylinders/${c.cylinderId}/inspections`;

      await post(admin, url)
        .send({
          inspectedAt: dia(3),
          result: 'approved',
          nextDueAt: dia(9),
        })
        .expect(400);
      await post(admin, url)
        .send({ inspectedAt: dia(-1), result: 'approved' })
        .expect(400);
      await post(admin, url)
        .send({
          inspectedAt: dia(-1),
          result: 'conditional',
          nextDueAt: dia(-2),
        })
        .expect(400);
      await post(admin, url)
        .send({ inspectedAt: dia(-1), result: 'roto', nextDueAt: dia(9) })
        .expect(400);
      await post(admin, url).send({ result: 'approved' }).expect(400);
      await post(admin, '/cylinders/no-es-uuid/inspections')
        .send({
          inspectedAt: dia(-1),
          result: 'approved',
          nextDueAt: dia(9),
        })
        .expect(400);
      expect(await ds.getRepository(CylinderInspection).count()).toBe(0);
    });

    it('un envase dado de baja no admite revisiones (409)', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const c = await envase(d.distributorId, 'SN-1', {
        state: CylinderState.RETIRED,
      });
      await post(admin, `/cylinders/${c.cylinderId}/inspections`)
        .send({
          inspectedAt: dia(-1),
          result: 'approved',
          nextDueAt: dia(9),
        })
        .expect(409);
    });

    it('un envase de otra distribuidora responde 404 y no se toca', async () => {
      const a = await distribuidora();
      const b = await distribuidora();
      const adminA = await adminDe(a.distributorId);
      const deB = await envase(b.distributorId, 'SN-B');

      await post(adminA, `/cylinders/${deB.cylinderId}/inspections`)
        .send({
          inspectedAt: dia(-1),
          result: 'approved',
          nextDueAt: dia(9),
        })
        .expect(404);
      expect(await ds.getRepository(CylinderInspection).count()).toBe(0);
    });
  });

  describe('GET vigencia (CU-133)', () => {
    it('por id y por serial: fechas, días que faltan e historial', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const c = await envase(d.distributorId, 'SN-1');
      await post(admin, `/cylinders/${c.cylinderId}/inspections`)
        .send({
          inspectedAt: dia(-1),
          result: 'approved',
          nextDueAt: dia(40),
        })
        .expect(201);

      const porId = cuerpo<Vigencia>(
        await get(admin, `/cylinders/${c.cylinderId}/vigencia`).expect(200),
      );
      const porSerial = cuerpo<Vigencia>(
        await get(admin, '/cylinders/vigencia/serial/SN-1').expect(200),
      );

      expect(porId.daysRemaining).toBe(40);
      expect(porId.inspections).toHaveLength(1);
      expect(porSerial.cylinderId).toBe(c.cylinderId);
    });

    it('sin revisión registrada: "unverified", no vencido', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const c = await envase(d.distributorId, 'SN-1');

      const v = cuerpo<Vigencia>(
        await get(admin, `/cylinders/${c.cylinderId}/vigencia`).expect(200),
      );

      expect(v.status).toBe('unverified');
      expect(v.daysRemaining).toBeNull();
      expect(v.inspections).toEqual([]);
    });

    it('vencido: días negativos', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const c = await envase(d.distributorId, 'SN-1', {
        expiresAt: new Date(enDias(-5)),
      });
      const v = cuerpo<Vigencia>(
        await get(admin, `/cylinders/${c.cylinderId}/vigencia`).expect(200),
      );
      expect(v.status).toBe('expired');
      expect(v.daysRemaining).toBe(-5);
    });

    it('404 si no existe o es de otra distribuidora (por id y por serial)', async () => {
      const a = await distribuidora();
      const b = await distribuidora();
      const adminA = await adminDe(a.distributorId);
      const deB = await envase(b.distributorId, 'SN-B');

      await get(adminA, `/cylinders/${deB.cylinderId}/vigencia`).expect(404);
      await get(adminA, '/cylinders/vigencia/serial/SN-B').expect(404);
      await get(adminA, `/cylinders/${randomUUID()}/vigencia`).expect(404);
      await get(adminA, '/cylinders/no-es-uuid/vigencia').expect(400);
    });
  });

  describe('GET /cylinders/vigencia/proximos-a-vencer (CU-134)', () => {
    it('separa vencidos, por vencer y sin revisión; ordena por urgencia; deja afuera lo lejano y las bajas', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      await envase(d.distributorId, 'VENCIDO', {
        expiresAt: new Date(enDias(-3)),
      });
      await envase(d.distributorId, 'EN-20', {
        expiresAt: new Date(enDias(20)),
      });
      await envase(d.distributorId, 'EN-5', { expiresAt: new Date(enDias(5)) });
      await envase(d.distributorId, 'LEJANO', {
        expiresAt: new Date(enDias(200)),
      });
      await envase(d.distributorId, 'SIN-FECHA');
      await envase(d.distributorId, 'BAJA', {
        expiresAt: new Date(enDias(-30)),
        state: CylinderState.RETIRED,
      });

      const r = cuerpo<Vencimientos>(
        await get(
          admin,
          '/cylinders/vigencia/proximos-a-vencer?days=30',
        ).expect(200),
      );

      expect(r.windowDays).toBe(30);
      expect(r.expired.map((e) => e.serial)).toEqual(['VENCIDO']);
      expect(r.expiring.map((e) => e.serial)).toEqual(['EN-5', 'EN-20']);
      expect(r.unverified.map((e) => e.serial)).toEqual(['SIN-FECHA']);
    });

    it('la ventana es la que elige el administrador; sin ella son 30 días', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      await envase(d.distributorId, 'EN-20', {
        expiresAt: new Date(enDias(20)),
      });

      const corta = cuerpo<Vencimientos>(
        await get(admin, '/cylinders/vigencia/proximos-a-vencer?days=7').expect(
          200,
        ),
      );
      const porDefecto = cuerpo<Vencimientos>(
        await get(admin, '/cylinders/vigencia/proximos-a-vencer').expect(200),
      );

      expect(corta.expiring).toEqual([]);
      expect(porDefecto.windowDays).toBe(30);
      expect(porDefecto.expiring).toHaveLength(1);
    });

    it('ningún envase en la ventana: lista vacía', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const r = cuerpo<Vencimientos>(
        await get(admin, '/cylinders/vigencia/proximos-a-vencer').expect(200),
      );
      expect(r).toEqual({
        windowDays: 30,
        totals: { expired: 0, expiring: 0, unverified: 0 },
        expired: [],
        expiring: [],
        unverified: [],
      });
    });

    it('rechaza una ventana fuera de rango y no muestra envases de otra distribuidora', async () => {
      const a = await distribuidora();
      const b = await distribuidora();
      const adminA = await adminDe(a.distributorId);
      await envase(b.distributorId, 'AJENO', {
        expiresAt: new Date(enDias(-1)),
      });

      await get(adminA, '/cylinders/vigencia/proximos-a-vencer?days=0').expect(
        400,
      );
      await get(
        adminA,
        '/cylinders/vigencia/proximos-a-vencer?days=366',
      ).expect(400);
      const r = cuerpo<Vencimientos>(
        await get(adminA, '/cylinders/vigencia/proximos-a-vencer').expect(200),
      );
      expect(r.expired).toEqual([]);
      expect(r.unverified).toEqual([]);
    });
  });

  describe('POST /cylinders/assign (CU-135)', () => {
    it('rechaza la asignación completa si algún envase está vencido: 409 con los seriales y ninguno queda asignado', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const ped = await pedido(d.distributorId);
      const bueno = await envase(d.distributorId, 'OK', {
        expiresAt: new Date(enDias(100)),
      });
      const malo = await envase(d.distributorId, 'MALO', {
        expiresAt: new Date(enDias(-1)),
      });

      const r = await post(admin, '/cylinders/assign')
        .send({ orderId: ped.orderId, serials: ['OK', 'MALO'] })
        .expect(409);

      const e = cuerpo<Rechazo>(r);
      expect(e.code).toBe('CYLINDER_EXPIRED');
      expect(e.serials).toEqual(['MALO']);
      expect(await estadoDe(bueno.cylinderId)).toBe(CylinderState.FILLED);
      expect(await estadoDe(malo.cylinderId)).toBe(CylinderState.FILLED);
      expect(
        (
          await ds
            .getRepository(Cylinder)
            .findOneByOrFail({ cylinderId: bueno.cylinderId })
        ).currentOrderId,
      ).toBeNull();
      expect(await ds.getRepository(CylinderMovement).count()).toBe(0);
    });

    it('un envase sin vencimiento cargado y uno vigente se asignan en una sola operación', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const ped = await pedido(d.distributorId);
      const sinFecha = await envase(d.distributorId, 'SIN-FECHA');
      const vigente = await envase(d.distributorId, 'VIGENTE', {
        expiresAt: new Date(enDias(10)),
      });

      await post(admin, '/cylinders/assign')
        .send({ orderId: ped.orderId, serials: ['SIN-FECHA', 'VIGENTE'] })
        .expect(201);

      expect(await estadoDe(sinFecha.cylinderId)).toBe(
        CylinderState.DISPATCHED,
      );
      expect(await estadoDe(vigente.cylinderId)).toBe(CylinderState.DISPATCHED);
      const notas = (
        await ds
          .getRepository(CylinderMovement)
          .findBy({ cylinderId: sinFecha.cylinderId })
      ).map((m) => m.note);
      expect(notas[0]).toContain('sin revisión registrada');
    });

    it('es atómica: si un envase no se puede despachar, los otros quedan como estaban', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const ped = await pedido(d.distributorId);
      const uno = await envase(d.distributorId, 'UNO');
      const dos = await envase(d.distributorId, 'DOS');
      const vacio = await envase(d.distributorId, 'VACIO', {
        state: CylinderState.IN_DEPOT,
      });

      await post(admin, '/cylinders/assign')
        .send({ orderId: ped.orderId, serials: ['UNO', 'DOS', 'VACIO'] })
        .expect(400);

      expect(await estadoDe(uno.cylinderId)).toBe(CylinderState.FILLED);
      expect(await estadoDe(dos.cylinderId)).toBe(CylinderState.FILLED);
      expect(await estadoDe(vacio.cylinderId)).toBe(CylinderState.IN_DEPOT);
      expect(await ds.getRepository(CylinderMovement).count()).toBe(0);
    });

    it('un serial inexistente o de otra distribuidora es 404 y no asigna nada; un pedido ajeno también', async () => {
      const a = await distribuidora();
      const b = await distribuidora();
      const adminA = await adminDe(a.distributorId);
      const ped = await pedido(a.distributorId);
      const pedidoB = await pedido(b.distributorId);
      const propio = await envase(a.distributorId, 'PROPIO');
      await envase(b.distributorId, 'AJENO');

      await post(adminA, '/cylinders/assign')
        .send({ orderId: ped.orderId, serials: ['PROPIO', 'AJENO'] })
        .expect(404);
      await post(adminA, '/cylinders/assign')
        .send({ orderId: pedidoB.orderId, serials: ['PROPIO'] })
        .expect(404);
      expect(await estadoDe(propio.cylinderId)).toBe(CylinderState.FILLED);
    });

    it('seriales repetidos: 400', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const ped = await pedido(d.distributorId);
      await envase(d.distributorId, 'UNO');
      await post(admin, '/cylinders/assign')
        .send({ orderId: ped.orderId, serials: ['UNO', 'UNO'] })
        .expect(400);
    });

    it('revisar un envase como rechazado lo bloquea para el despacho', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const ped = await pedido(d.distributorId);
      const c = await envase(d.distributorId, 'SN-1', {
        expiresAt: new Date(enDias(300)),
      });
      await post(admin, `/cylinders/${c.cylinderId}/inspections`)
        .send({ inspectedAt: dia(-1), result: 'rejected' })
        .expect(201);

      const r = await post(admin, '/cylinders/assign')
        .send({ orderId: ped.orderId, serials: ['SN-1'] })
        .expect(409);
      expect(cuerpo<Rechazo>(r).serials).toEqual(['SN-1']);
    });
  });

  describe('GET /cylinders filtros de reemplazo (CU-135 paso 5)', () => {
    it('filtra por tipo de producto y por vigencia', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const tipo = await ds.getRepository(GasCylinder).save({
        distributorId: d.distributorId,
        type: 'Garrafa 10kg',
        weight: 10,
        price: 1000,
        stock: 0,
      } as Partial<GasCylinder>);
      await envase(d.distributorId, 'VIG', {
        gasCylinderId: tipo.gasCylinderId,
        expiresAt: new Date(enDias(30)),
      });
      await envase(d.distributorId, 'VENC', {
        gasCylinderId: tipo.gasCylinderId,
        expiresAt: new Date(enDias(-1)),
      });
      await envase(d.distributorId, 'SIN', {
        gasCylinderId: tipo.gasCylinderId,
      });
      await envase(d.distributorId, 'OTRO-TIPO', {
        expiresAt: new Date(enDias(30)),
      });
      const series = (r: request.Response) =>
        cuerpo<Array<{ serial: string }>>(r)
          .map((f) => f.serial)
          .sort();

      expect(
        series(await get(admin, '/cylinders?vigencia=valid').expect(200)),
      ).toEqual(['OTRO-TIPO', 'VIG']);
      expect(
        series(await get(admin, '/cylinders?vigencia=expired').expect(200)),
      ).toEqual(['VENC']);
      expect(
        series(await get(admin, '/cylinders?vigencia=unverified').expect(200)),
      ).toEqual(['SIN']);
      expect(
        series(
          await get(
            admin,
            `/cylinders?gasCylinderId=${tipo.gasCylinderId}&vigencia=valid`,
          ).expect(200),
        ),
      ).toEqual(['VIG']);
      await get(admin, '/cylinders?vigencia=roto').expect(400);
    });
  });

  describe('Corrección tras revisión', () => {
    const patch = (quien: User, url: string) =>
      como(quien, request(servidor()).patch(url));

    async function choferDe(distributorId: string) {
      const r = await rol(RoleType.DELIVERY);
      const user = await ds.getRepository(User).save({
        email: `chofer.${randomUUID().slice(0, 8)}@test.local`,
        fullName: 'Chofer',
        roleId: r.roleId,
      } as Partial<User>);
      await ds.getRepository(Delivery).save({
        userId: user.userId,
        distributorId,
        validated: true,
        isEnabled: true,
      } as Partial<Delivery>);
      return user;
    }

    const desdeApp = (quien: User, req: request.Test) =>
      req
        .set('Authorization', `Bearer ${quien.email}`)
        .set('X-Client-Source', 'driver-app');

    it('B1: /transition a dispatched con un envase vencido es 409 y no cambia nada', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const c = await envase(d.distributorId, 'VENCIDO', {
        expiresAt: new Date(enDias(-1)),
      });

      const r = await patch(admin, `/cylinders/${c.cylinderId}/transition`)
        .send({ toState: 'dispatched' })
        .expect(409);

      expect(cuerpo<Rechazo>(r)).toMatchObject({
        code: 'CYLINDER_EXPIRED',
        serials: ['VENCIDO'],
      });
      expect(await estadoDe(c.cylinderId)).toBe(CylinderState.FILLED);
      expect(await ds.getRepository(CylinderMovement).count()).toBe(0);
    });

    it('B1: el chofer (DELIVERY) también recibe el 409 al despachar un vencido, y un vigente pasa', async () => {
      const d = await distribuidora();
      const chofer = await choferDe(d.distributorId);
      const vencido = await envase(d.distributorId, 'VENCIDO', {
        expiresAt: new Date(enDias(-1)),
      });
      const vigente = await envase(d.distributorId, 'VIGENTE', {
        expiresAt: new Date(enDias(30)),
      });
      // El chofer despacha en el contexto de un pedido suyo (sin `orderId`, 403).
      const { deliveryId } = await ds
        .getRepository(Delivery)
        .findOneByOrFail({ userId: chofer.userId });
      const suyo = await pedido(d.distributorId);
      await ds.getRepository(Order).update(suyo.orderId, {
        status: OrderStatus.ACCEPTED,
        acceptedAt: new Date(),
        deliveryId,
      });

      const r = await desdeApp(
        chofer,
        conIdempotencia(servidor()).patch(
          `/cylinders/${vencido.cylinderId}/transition`,
        ),
      )
        .send({ toState: 'dispatched', orderId: suyo.orderId })
        .expect(409);
      expect(cuerpo<Rechazo>(r).code).toBe('CYLINDER_EXPIRED');

      await desdeApp(
        chofer,
        conIdempotencia(servidor()).patch(
          `/cylinders/${vigente.cylinderId}/transition`,
        ),
      )
        .send({ toState: 'dispatched', orderId: suyo.orderId })
        .expect(200);
      expect(await estadoDe(vigente.cylinderId)).toBe(CylinderState.DISPATCHED);
    });

    it('B1: un vencido puede volver al depósito y un envase de otra distribuidora es 404', async () => {
      const a = await distribuidora();
      const b = await distribuidora();
      const adminA = await adminDe(a.distributorId);
      const vencido = await envase(a.distributorId, 'VENCIDO', {
        expiresAt: new Date(enDias(-1)),
      });
      const deB = await envase(b.distributorId, 'AJENO', {
        expiresAt: new Date(enDias(-1)),
      });

      await patch(adminA, `/cylinders/${vencido.cylinderId}/transition`)
        .send({ toState: 'in_depot' })
        .expect(200);
      await patch(adminA, `/cylinders/${deB.cylinderId}/transition`)
        .send({ toState: 'dispatched' })
        .expect(404);
    });

    it('I1: el envase que vence hoy se despacha hasta el final del día de Buenos Aires', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const ped = await pedido(d.distributorId);
      const hoy = await envase(d.distributorId, 'HOY', {
        expiresAt: finDelDia(dia(0)),
      });
      const ayer = await envase(d.distributorId, 'AYER', {
        expiresAt: finDelDia(dia(-1)),
      });

      const v = cuerpo<Vigencia>(
        await get(admin, `/cylinders/${hoy.cylinderId}/vigencia`).expect(200),
      );
      expect(v).toMatchObject({ status: 'valid', daysRemaining: 0 });
      await post(admin, '/cylinders/assign')
        .send({ orderId: ped.orderId, serials: ['AYER'] })
        .expect(409);
      await post(admin, '/cylinders/assign')
        .send({ orderId: ped.orderId, serials: ['HOY'] })
        .expect(201);
      expect(await estadoDe(ayer.cylinderId)).toBe(CylinderState.FILLED);
    });

    it('I1: la revisión de hoy con vencimiento mañana deja 1 día', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const c = await envase(d.distributorId, 'SN-1');
      const r = await post(admin, `/cylinders/${c.cylinderId}/inspections`)
        .send({ inspectedAt: dia(0), result: 'approved', nextDueAt: dia(1) })
        .expect(201);
      expect(cuerpo<Vigencia>(r)).toMatchObject({
        status: 'valid',
        daysRemaining: 1,
      });
    });

    it('I2: un despacho inválido (no está lleno) es 400 aunque otro envase esté vencido', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const ped = await pedido(d.distributorId);
      await envase(d.distributorId, 'VENCIDO', {
        expiresAt: new Date(enDias(-1)),
      });
      await envase(d.distributorId, 'VACIO', { state: CylinderState.IN_DEPOT });

      await post(admin, '/cylinders/assign')
        .send({ orderId: ped.orderId, serials: ['VENCIDO', 'VACIO'] })
        .expect(400);
    });

    it('dos asignaciones concurrentes del mismo serial: una gana y la otra es 400', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const uno = await pedido(d.distributorId);
      const dos = await pedido(d.distributorId);
      const c = await envase(d.distributorId, 'CARRERA');

      const [r1, r2] = await Promise.all([
        post(admin, '/cylinders/assign').send({
          orderId: uno.orderId,
          serials: ['CARRERA'],
        }),
        post(admin, '/cylinders/assign').send({
          orderId: dos.orderId,
          serials: ['CARRERA'],
        }),
      ]);

      expect([r1.status, r2.status].sort()).toEqual([201, 400]);
      const ganador = r1.status === 201 ? uno : dos;
      const ficha = await ds
        .getRepository(Cylinder)
        .findOneByOrFail({ cylinderId: c.cylinderId });
      expect(ficha.currentOrderId).toBe(ganador.orderId);
      expect(await ds.getRepository(CylinderMovement).count()).toBe(1);
    });

    it('PATCH /cylinders/:id ya no edita el vencimiento ni la última revisión', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      const c = await envase(d.distributorId, 'SN-1');
      await patch(admin, `/cylinders/${c.cylinderId}`)
        .send({ expiresAt: enDias(10) })
        .expect(400);
      await patch(admin, `/cylinders/${c.cylinderId}`)
        .send({ lastInspectionAt: enDias(-10) })
        .expect(400);
    });

    it('vigencia=dispatchable incluye vigentes y sin revisión, no los vencidos', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      await envase(d.distributorId, 'VIG', { expiresAt: new Date(enDias(5)) });
      await envase(d.distributorId, 'VENC', {
        expiresAt: new Date(enDias(-5)),
      });
      await envase(d.distributorId, 'SIN');

      const r = await get(admin, '/cylinders?vigencia=dispatchable').expect(
        200,
      );
      expect(
        cuerpo<Array<{ serial: string }>>(r)
          .map((f) => f.serial)
          .sort(),
      ).toEqual(['SIN', 'VIG']);
    });

    it('el serial por vigencia exige distribuidora al super admin', async () => {
      const d = await distribuidora();
      const r = await rol(RoleType.SUPER_ADMIN);
      const sup = await ds.getRepository(User).save({
        email: `sup.${randomUUID().slice(0, 8)}@test.local`,
        fullName: 'Super',
        roleId: r.roleId,
      } as Partial<User>);
      await ds
        .getRepository(Admin)
        .save({ userId: sup.userId, distributorId: null } as Partial<Admin>);
      await envase(d.distributorId, 'SN-1');

      await get(sup, '/cylinders/vigencia/serial/SN-1').expect(400);
      await como(
        sup,
        request(servidor())
          .get('/cylinders/vigencia/serial/SN-1')
          .set('X-Distributor', d.distributorId),
      ).expect(200);
    });

    it('proximos-a-vencer pagina cada grupo y informa los totales', async () => {
      const d = await distribuidora();
      const admin = await adminDe(d.distributorId);
      for (const n of [1, 2, 3]) {
        await envase(d.distributorId, `SIN-${n}`);
      }
      await envase(d.distributorId, 'VENC', {
        expiresAt: new Date(enDias(-2)),
      });

      const r = cuerpo<
        Vencimientos & { totals: { unverified: number; expired: number } }
      >(
        await get(
          admin,
          '/cylinders/vigencia/proximos-a-vencer?limit=2&offset=2',
        ).expect(200),
      );

      expect(r.totals).toMatchObject({ unverified: 3, expired: 1 });
      expect(r.unverified.map((e) => e.serial)).toEqual(['SIN-3']);
      await get(admin, '/cylinders/vigencia/proximos-a-vencer?limit=0').expect(
        400,
      );
    });
  });
});
