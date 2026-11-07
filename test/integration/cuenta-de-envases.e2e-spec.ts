/** Verifica el SQL contra el esquema real: gas_cylinder usa "isActive". */
import { DataSource } from 'typeorm';
import {
  createTestApp,
  sembrarClienteAutenticado,
  TestEnv,
  truncateAllTables,
} from './setup/test-env';
import { CustomerContainerService } from '../../src/customer-container/customer-container.service';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { CustomerContainerMovementReason } from '../../src/customer-container/entities/customer-container-movement.entity';

describe('Cuenta de envases (Postgres real)', () => {
  let env: TestEnv;
  let dataSource: DataSource;
  let cuentas: CustomerContainerService;

  beforeAll(async () => {
    env = await createTestApp();
    dataSource = env.app.get(DataSource);
    cuentas = env.app.get(CustomerContainerService);
  }, 240000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  it('lista tipos activos con saldo cero e inactivos que el cliente ya posee', async () => {
    const { distributor, user } = await sembrarClienteAutenticado(env.app);
    const tipos = dataSource.getRepository(GasCylinder);
    const activo = await tipos.save({
      distributorId: distributor.distributorId,
      type: '10 kg',
      weight: 10,
      price: 1000,
      stock: 0,
      isActive: true,
    } as Partial<GasCylinder>);
    const inactivo = await tipos.save({
      distributorId: distributor.distributorId,
      type: '15 kg',
      weight: 15,
      price: 1500,
      stock: 0,
      isActive: false,
    } as Partial<GasCylinder>);

    await dataSource.transaction((manager) =>
      cuentas.registrar(manager, {
        distributorId: distributor.distributorId,
        customerUserId: user.userId,
        gasCylinderId: inactivo.gasCylinderId,
        quantity: 2,
        reason: CustomerContainerMovementReason.MANUAL_ADJUSTMENT,
        note: 'Ajuste inicial válido',
      }),
    );

    await expect(
      cuentas.listar(
        dataSource.manager,
        distributor.distributorId,
        user.userId,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gasCylinderId: activo.gasCylinderId,
          owned: 0,
          isActive: true,
        }),
        expect.objectContaining({
          gasCylinderId: inactivo.gasCylinderId,
          owned: 2,
          isActive: false,
        }),
      ]),
    );
  });

  it('suma, resta y rechaza el saldo negativo sin dejar movimiento (UPDATE … RETURNING real)', async () => {
    const { distributor, user } = await sembrarClienteAutenticado(env.app);
    const tipo = await dataSource.getRepository(GasCylinder).save({
      distributorId: distributor.distributorId,
      type: '10 kg',
      weight: 10,
      price: 1000,
      stock: 0,
      isActive: true,
    } as Partial<GasCylinder>);
    const ajuste = (quantity: number) =>
      dataSource.transaction((manager) =>
        cuentas.registrar(manager, {
          distributorId: distributor.distributorId,
          customerUserId: user.userId,
          gasCylinderId: tipo.gasCylinderId,
          quantity,
          reason: CustomerContainerMovementReason.MANUAL_ADJUSTMENT,
          note: 'Ajuste de la prueba e2e',
        }),
      );
    const movimientos = async (): Promise<number> => {
      const filas: Array<{ n: number }> = await dataSource.query(
        `SELECT count(*)::int AS n FROM customer_container_movement m
           JOIN customer_container_account a ON a.account_id = m.account_id
          WHERE a.customer_user_id = $1`,
        [user.userId],
      );
      return filas[0].n;
    };

    await expect(ajuste(3)).resolves.toBe(3);
    await expect(ajuste(-2)).resolves.toBe(1);
    expect(await movimientos()).toBe(2);
    await expect(ajuste(-2)).rejects.toThrow(
      'El cliente quedaría con envases negativos',
    );
    expect(await movimientos()).toBe(2);
    const [cuenta]: Array<{ owned: number }> = await dataSource.query(
      `SELECT owned FROM customer_container_account WHERE customer_user_id = $1`,
      [user.userId],
    );
    expect(cuenta.owned).toBe(1);
  });
});
