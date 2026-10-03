/**
 * Integración HTTP (supertest + Postgres real) de los filtros que usa el panel: clientes por
 * estado, usuarios por rol y envases por pedido y por cliente. Lo que los
 * mocks no demuestran: el SQL, los EXISTS de pertenencia y el aislamiento.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { TestEnv, createTestApp, truncateAllTables } from './setup/test-env';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { User } from '../../src/users/entities/user.entity';
import { Role } from '../../src/role/entities/role.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import {
  Cylinder,
  CylinderState,
} from '../../src/cylinder/entities/cylinder.entity';
import { Admin } from '../../src/admin/entities/admin.entity';
import { RoleType } from '../../src/common/constants/role-type.enum';

describe('Filtros del panel (e2e)', () => {
  let env: TestEnv;
  let dataSource: DataSource;

  beforeAll(async () => {
    env = await createTestApp();
    dataSource = env.app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  const seedDistribuidora = () =>
    dataSource.getRepository(Distributor).save({
      name: 'Distribuidora Test',
      slug: `test-${randomUUID()}`,
    } as Partial<Distributor>);

  const seedRol = async (type: RoleType) =>
    (await dataSource.getRepository(Role).findOneBy({ type })) ??
    dataSource.getRepository(Role).save({ type } as Partial<Role>);

  async function seedCliente(
    distributorId: string,
    opciones: { blocked?: boolean; pidio?: boolean } = {},
  ) {
    const sufijo = randomUUID().slice(0, 8);
    const rol = await seedRol(RoleType.CUSTOMER);
    const user = await dataSource.getRepository(User).save({
      email: `cliente.${sufijo}@test.local`,
      fullName: `Cliente ${sufijo}`,
      roleId: rol.roleId,
      blocked: opciones.blocked ?? false,
    } as Partial<User>);
    await dataSource
      .getRepository(Customer)
      .save({ userId: user.userId } as Partial<Customer>);
    let pedido: Order | null = null;
    if (opciones.pidio ?? true) {
      const address = await dataSource.getRepository(UserAddress).save({
        userId: user.userId,
        street: 'Av. Test 123',
        city: 'CABA',
        latitude: '-34.6037',
        longitude: '-58.3816',
      } as Partial<UserAddress>);
      pedido = await dataSource.getRepository(Order).save({
        customerId: user.userId,
        distributorId,
        addressId: address.addressId,
        status: OrderStatus.DELIVERED,
        paymentMethod: PaymentMethod.CASH,
        totalAmount: 1000,
        subtotalItems: 1000,
      } as Partial<Order>);
    }
    return { user, pedido };
  }

  async function seedChofer(distributorId: string) {
    const sufijo = randomUUID().slice(0, 8);
    const rol = await seedRol(RoleType.DELIVERY);
    const user = await dataSource.getRepository(User).save({
      email: `chofer.${sufijo}@test.local`,
      fullName: `Chofer ${sufijo}`,
      roleId: rol.roleId,
    } as Partial<User>);
    await dataSource
      .getRepository(Delivery)
      .save({ distributorId, userId: user.userId } as Partial<Delivery>);
    return user;
  }

  async function seedAdmin(
    tipo: RoleType.ADMIN | RoleType.SUPER_ADMIN,
    distributorId: string | null,
  ) {
    const sufijo = randomUUID().slice(0, 8);
    const rol = await seedRol(tipo);
    const user = await dataSource.getRepository(User).save({
      email: `${tipo}.${sufijo}@test.local`,
      fullName: `Admin ${sufijo}`,
      roleId: rol.roleId,
    } as Partial<User>);
    await dataSource
      .getRepository(Admin)
      .save({ userId: user.userId, distributorId } as Partial<Admin>);
    return user;
  }

  /** GET como el panel: el token de prueba es el correo. */
  const get = (
    quien: User,
    url: string,
    distribuidora?: string,
  ): request.Test => {
    const req = request(env.app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${quien.email}`)
      .set('X-Client-Source', 'panel-app');
    return distribuidora ? req.set('X-Distributor', distribuidora) : req;
  };

  interface Envase {
    cylinder_id: string;
    serial: string;
    lastMovementAt: string | null;
    current_customer: { user_id: string } | null;
  }
  interface ListadoUsuarios {
    users: Array<{ user_id: string }>;
    maxUsers: number;
  }
  const cuerpo = <T>(r: request.Response): T => r.body as T;
  const ids = (r: request.Response) =>
    cuerpo<Array<{ user_id: string }>>(r)
      .map((f) => f.user_id)
      .sort();

  describe('GET /customers?status=', () => {
    it('separa activos de bloqueados, cuenta bien y respeta el tenant', async () => {
      const a = await seedDistribuidora();
      const b = await seedDistribuidora();
      const adminA = await seedAdmin(RoleType.ADMIN, a.distributorId);
      const superAdmin = await seedAdmin(RoleType.SUPER_ADMIN, null);
      const activo = await seedCliente(a.distributorId);
      const bloqueado = await seedCliente(a.distributorId, { blocked: true });
      await seedCliente(b.distributorId, { blocked: true });

      const activos = await get(adminA, '/customers?status=active').expect(200);
      expect(ids(activos)).toEqual([activo.user.userId]);
      expect(activos.headers['x-total-count']).toBe('1');

      const bloqueados = await get(adminA, '/customers?status=blocked').expect(
        200,
      );
      expect(ids(bloqueados)).toEqual([bloqueado.user.userId]);
      expect(bloqueados.headers['x-total-count']).toBe('1');

      const todos = await get(adminA, '/customers').expect(200);
      expect(todos.headers['x-total-count']).toBe('2');

      // Super admin: sin header ve las dos distribuidoras; con header, una.
      const global = await get(superAdmin, '/customers?status=blocked').expect(
        200,
      );
      expect(global.headers['x-total-count']).toBe('2');
      const deB = await get(
        superAdmin,
        '/customers?status=blocked',
        b.slug,
      ).expect(200);
      expect(deB.headers['x-total-count']).toBe('1');
    }, 30000);

    it('400 con un status inválido y con role (ya no se acepta acá)', async () => {
      const a = await seedDistribuidora();
      const adminA = await seedAdmin(RoleType.ADMIN, a.distributorId);
      await get(adminA, '/customers?status=borrado').expect(400);
      await get(adminA, '/customers?role=admin').expect(400);
    }, 30000);
  });

  describe('GET /users?role=', () => {
    it('filtra por rol, trae el total en cuerpo y cabecera y respeta el tenant', async () => {
      const a = await seedDistribuidora();
      const b = await seedDistribuidora();
      const adminA = await seedAdmin(RoleType.ADMIN, a.distributorId);
      const superAdmin = await seedAdmin(RoleType.SUPER_ADMIN, null);
      const chofer = await seedChofer(a.distributorId);
      await seedChofer(b.distributorId);
      await seedCliente(a.distributorId);

      const choferes = await get(adminA, '/users?role=delivery').expect(200);
      expect(
        cuerpo<ListadoUsuarios>(choferes).users.map((u) => u.user_id),
      ).toEqual([chofer.userId]);
      expect(cuerpo<ListadoUsuarios>(choferes).maxUsers).toBe(1);
      expect(choferes.headers['x-total-count']).toBe('1');

      const clientesDeA = await get(adminA, '/users?role=customer').expect(200);
      expect(clientesDeA.headers['x-total-count']).toBe('1');

      // El admin de A se ve a sí mismo, al chofer y al cliente.
      const todos = await get(adminA, '/users').expect(200);
      expect(todos.headers['x-total-count']).toBe('3');

      const global = await get(superAdmin, '/users?role=delivery').expect(200);
      expect(global.headers['x-total-count']).toBe('2');
      const deB = await get(superAdmin, '/users?role=delivery', b.slug).expect(
        200,
      );
      expect(deB.headers['x-total-count']).toBe('1');
    }, 30000);

    it('400 con un role inválido', async () => {
      const a = await seedDistribuidora();
      const adminA = await seedAdmin(RoleType.ADMIN, a.distributorId);
      await get(adminA, '/users?role=chofer').expect(400);
    }, 30000);
  });

  describe('GET /cylinders', () => {
    async function seedEnvase(
      distributorId: string,
      serial: string,
      over: Partial<Cylinder> = {},
    ) {
      return dataSource.getRepository(Cylinder).save({
        distributorId,
        serial,
        state: CylinderState.IN_DEPOT,
        ...over,
      } as Partial<Cylinder>);
    }

    const mover = (
      cylinder: Cylinder,
      orderId: string | null,
      toState: CylinderState,
      cuando: string,
    ) =>
      dataSource.query(
        `INSERT INTO cylinder_movement (cylinder_id, distributor_id, to_state, order_id, "createdAt")
         VALUES ($1, $2, $3, $4, $5)`,
        [cylinder.cylinderId, cylinder.distributorId, toState, orderId, cuando],
      );

    const series = (filas: Array<{ serial: string }>) =>
      filas.map((f) => f.serial).sort();

    it('por pedido (actual e histórico), por cliente, combinado, paginado y aislado', async () => {
      const a = await seedDistribuidora();
      const b = await seedDistribuidora();
      const adminA = await seedAdmin(RoleType.ADMIN, a.distributorId);
      const superAdmin = await seedAdmin(RoleType.SUPER_ADMIN, null);
      const { user, pedido } = await seedCliente(a.distributorId);
      const { pedido: otroPedido } = await seedCliente(a.distributorId);
      const ped = pedido as Order;

      const enViaje = await seedEnvase(a.distributorId, 'SN-VIAJE', {
        state: CylinderState.DISPATCHED,
        currentOrderId: ped.orderId,
      });
      await mover(
        enViaje,
        ped.orderId,
        CylinderState.DISPATCHED,
        '2026-10-01T10:00:00Z',
      );
      const devuelto = await seedEnvase(a.distributorId, 'SN-DEVUELTO', {
        state: CylinderState.EMPTY_RETURNED,
      });
      await mover(
        devuelto,
        ped.orderId,
        CylinderState.WITH_CUSTOMER,
        '2026-09-01T10:00:00Z',
      );
      await mover(
        devuelto,
        null,
        CylinderState.EMPTY_RETURNED,
        '2026-09-20T10:00:00Z',
      );
      const conCliente = await seedEnvase(a.distributorId, 'SN-CLIENTE', {
        state: CylinderState.WITH_CUSTOMER,
        currentCustomerId: user.userId,
        currentOrderId: (otroPedido as Order).orderId,
      });
      await mover(
        conCliente,
        ped.orderId,
        CylinderState.WITH_CUSTOMER,
        '2026-09-10T10:00:00Z',
      );
      await seedEnvase(a.distributorId, 'SN-OTRO');
      const deB = await seedEnvase(b.distributorId, 'SN-VIAJE');
      await mover(
        deB,
        ped.orderId,
        CylinderState.DISPATCHED,
        '2026-10-02T10:00:00Z',
      );

      const porPedido = await get(
        adminA,
        `/cylinders?orderId=${ped.orderId}`,
      ).expect(200);
      expect(series(cuerpo<Envase[]>(porPedido))).toEqual([
        'SN-CLIENTE',
        'SN-DEVUELTO',
        'SN-VIAJE',
      ]);
      expect(porPedido.headers['x-total-count']).toBe('3');
      const dev = cuerpo<Envase[]>(porPedido).find(
        (c) => c.serial === 'SN-DEVUELTO',
      );
      expect(dev?.lastMovementAt).toBe('2026-09-20T10:00:00.000Z');

      const porCliente = await get(
        adminA,
        `/cylinders?customerUserId=${user.userId}`,
      ).expect(200);
      expect(series(cuerpo<Envase[]>(porCliente))).toEqual(['SN-CLIENTE']);
      expect(cuerpo<Envase[]>(porCliente)[0].current_customer?.user_id).toBe(
        user.userId,
      );

      const combinado = await get(
        adminA,
        `/cylinders?orderId=${ped.orderId}&state=empty_returned`,
      ).expect(200);
      expect(series(cuerpo<Envase[]>(combinado))).toEqual(['SN-DEVUELTO']);

      // Paginación: la página trae `limit` ítems y el total no cambia.
      const pagina = await get(
        adminA,
        `/cylinders?orderId=${ped.orderId}&limit=2&offset=0`,
      ).expect(200);
      expect(cuerpo<Envase[]>(pagina)).toHaveLength(2);
      expect(pagina.headers['x-total-count']).toBe('3');
      const resto = await get(
        adminA,
        `/cylinders?orderId=${ped.orderId}&limit=2&offset=2`,
      ).expect(200);
      expect(cuerpo<Envase[]>(resto)).toHaveLength(1);

      // Tenant: el admin de A nunca ve el envase de B aunque comparta pedido.
      expect(
        cuerpo<Envase[]>(porPedido).map((c) => c.cylinder_id),
      ).not.toContain(deB.cylinderId);
      // Super admin sin header ve las dos; con header, sólo la elegida.
      const global = await get(
        superAdmin,
        `/cylinders?orderId=${ped.orderId}`,
      ).expect(200);
      expect(global.headers['x-total-count']).toBe('4');
      const soloB = await get(
        superAdmin,
        `/cylinders?orderId=${ped.orderId}`,
        b.slug,
      ).expect(200);
      expect(cuerpo<Envase[]>(soloB).map((c) => c.cylinder_id)).toEqual([
        deB.cylinderId,
      ]);
    }, 30000);

    it('400 con state, UUID o paginación inválidos, y con el nombre viejo del parámetro', async () => {
      const a = await seedDistribuidora();
      const adminA = await seedAdmin(RoleType.ADMIN, a.distributorId);
      await get(adminA, '/cylinders?state=roto').expect(400);
      await get(adminA, '/cylinders?orderId=abc').expect(400);
      await get(adminA, '/cylinders?customerUserId=abc').expect(400);
      await get(adminA, '/cylinders?limit=0').expect(400);
      await get(adminA, `/cylinders?customerId=${randomUUID()}`).expect(400);
    }, 30000);
  });
});
