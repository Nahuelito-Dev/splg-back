/**
 * El SQL real de «rendición pendiente» del egreso del chofer (CU-181) contra un
 * Postgres de cero: filtra por distribuidora, por chofer y por estado, y ve el
 * efectivo entregado que ninguna rendición tomó.
 */
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { pendienteDeRendir } from '../../src/driver-settlement/application/rendicion-pendiente';
import { DriverSettlementStatus } from '../../src/driver-settlement/domain/driver-settlement.enums';
import { DriverSettlement } from '../../src/driver-settlement/entities/driver-settlement.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { telefonoDePrueba } from './setup/test-env';

describe('pendienteDeRendir (SQL real)', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;
  let rolId: string;
  let numero = 0;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer(
      process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4',
    )
      .withDatabase('splg_test')
      .withUsername('test')
      .withPassword('test')
      .start();
    ds = new DataSource({
      type: 'postgres',
      host: pg.getHost(),
      port: pg.getPort(),
      username: pg.getUsername(),
      password: pg.getPassword(),
      database: pg.getDatabase(),
      entities: [join(__dirname, '../../src/**/*.entity.ts')],
      migrations: [join(__dirname, '../../src/migrations/*.ts')],
      synchronize: false,
      migrationsTransactionMode: 'each',
    });
    await ds.initialize();
    await ds.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await ds.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await ds.runMigrations();
    rolId = (
      (await ds
        .getRepository(Role)
        .save({ type: 'delivery' } as Partial<Role>)) as Role
    ).roleId;
  }, 240000);

  afterAll(async () => {
    await ds.destroy();
    await pg.stop();
  });

  async function distribuidora(): Promise<string> {
    const sufijo = randomUUID().slice(0, 8);
    return (
      (await ds.getRepository(Distributor).save({
        name: `D ${sufijo}`,
        slug: `d-${sufijo}`,
      } as Partial<Distributor>)) as Distributor
    ).distributorId;
  }

  async function chofer(distributorId: string): Promise<string> {
    const user = (await ds.getRepository(User).save({
      email: `c.${randomUUID().slice(0, 8)}@splg.local`,
      fullName: 'Chofer',
      phoneNumber: telefonoDePrueba(),
      roleId: rolId,
    } as Partial<User>)) as User;
    return (
      (await ds.getRepository(Delivery).save({
        userId: user.userId,
        distributorId,
      } as Partial<Delivery>)) as Delivery
    ).deliveryId;
  }

  function rendicion(
    distributorId: string,
    deliveryId: string,
    status: DriverSettlementStatus,
    businessDate = '2026-10-30',
  ) {
    const presentada = status !== DriverSettlementStatus.OPEN;
    return ds.getRepository(DriverSettlement).save({
      distributorId,
      deliveryId,
      number: ++numero,
      businessDate,
      status,
      expectedCash: 1000,
      declaredCash: presentada ? 1000 : null,
      difference: presentada ? 0 : null,
      submittedAt: presentada ? new Date() : null,
      approvedAt:
        status === DriverSettlementStatus.APPROVED ? new Date() : null,
      driverExpenses: 0,
    } as Partial<DriverSettlement>);
  }

  async function entregadoEnEfectivo(
    distributorId: string,
    deliveryId: string,
    total: number,
  ) {
    const cliente = (await ds.getRepository(User).save({
      email: `k.${randomUUID().slice(0, 8)}@splg.local`,
      fullName: 'Cliente',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>)) as User;
    await ds.getRepository(Customer).save({
      userId: cliente.userId,
      notificationToken: 'x',
    } as Partial<Customer>);
    const direccion = (await ds.getRepository(UserAddress).save({
      userId: cliente.userId,
      street: 'Calle 1',
      city: 'Posadas',
      latitude: '-27.36',
      longitude: '-55.89',
    } as Partial<UserAddress>)) as UserAddress;
    await ds.getRepository(Order).save({
      customerId: cliente.userId,
      distributorId,
      addressId: direccion.addressId,
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: 'paid',
      totalAmount: total,
      subtotalItems: total,
      deliveryId,
      acceptedAt: new Date(Date.now() - 180_000),
      onTheWayAt: new Date(Date.now() - 120_000),
      deliveredAt: new Date(Date.now() - 60_000),
    } as unknown as Partial<Order>);
  }

  const pendiente = (distributorId: string, deliveryId: string) =>
    pendienteDeRendir(ds.manager, distributorId, deliveryId);

  it('un chofer sin rendiciones ni efectivo está al día', async () => {
    const d = await distribuidora();
    expect(await pendiente(d, await chofer(d))).toBeNull();
  });

  it.each([
    [DriverSettlementStatus.OPEN, 'abierta'],
    [DriverSettlementStatus.SUBMITTED, 'presentada'],
  ])(
    'una rendición %s es pendiente, con su N° y fecha',
    async (status, estado) => {
      const d = await distribuidora();
      const c = await chofer(d);
      const r = await rendicion(d, c, status, '2026-01-05');
      expect(await pendiente(d, c)).toEqual({
        tipo: 'rendicion',
        numero: r.number,
        estado,
        dia: '05/01/2026',
      });
    },
  );

  it('una rendición aprobada no es pendiente', async () => {
    const d = await distribuidora();
    const c = await chofer(d);
    await rendicion(d, c, DriverSettlementStatus.APPROVED);
    expect(await pendiente(d, c)).toBeNull();
  });

  it('ve las rendiciones de este chofer y de esta distribuidora, no las de otro', async () => {
    const d = await distribuidora();
    const otraD = await distribuidora();
    const c = await chofer(d);
    const otroChofer = await chofer(d);
    await rendicion(d, otroChofer, DriverSettlementStatus.OPEN);
    // La misma fila del chofer vista desde otra distribuidora no cuenta.
    await rendicion(d, c, DriverSettlementStatus.OPEN);
    expect(await pendiente(otraD, c)).toBeNull();
    expect(await pendiente(d, await chofer(d))).toBeNull();
  });

  it('efectivo entregado que ninguna rendición tomó es pendiente, con cantidad y monto', async () => {
    const d = await distribuidora();
    const c = await chofer(d);
    await entregadoEnEfectivo(d, c, 5000);
    await entregadoEnEfectivo(d, c, 2500.5);
    expect(await pendiente(d, c)).toEqual({
      tipo: 'efectivo',
      pedidos: 2,
      monto: '$ 7.500,50',
    });
  });

  it('el efectivo de otro chofer o de otra distribuidora no cuenta', async () => {
    const d = await distribuidora();
    const otraD = await distribuidora();
    const c = await chofer(d);
    await entregadoEnEfectivo(d, await chofer(d), 5000);
    await entregadoEnEfectivo(otraD, await chofer(otraD), 5000);
    expect(await pendiente(d, c)).toBeNull();
  });
});
