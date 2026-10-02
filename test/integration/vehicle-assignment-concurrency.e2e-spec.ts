/**
 * Tests de integración: la invariante de "vehículo en uso" (revisión del
 * 01/10) a nivel de BASE, no sólo en el código de la aplicación — contra
 * Postgres real (testcontainers), no un repo mockeado.
 *
 * Los dos índices únicos parciales de `vehicle_assignment`
 * (`released_at IS NULL`) son la última línea de defensa: un vehículo no
 * puede estar en uso por dos choferes a la vez, ni un chofer puede tener dos
 * vehículos en uso a la vez.
 *
 * La carrera se fuerza a mano con dos `QueryRunner` en transacciones propias
 * (no con dos llamadas a `ponerEnUso` vía `Promise.allSettled`): el service
 * hace varias consultas de validación ANTES de la transacción
 * (`assertSinViajeEnCurso`, el `findOne` de quién tiene el auto), así que la
 * segunda llamada casi siempre alcanza a ver el estado ya confirmado de la
 * primera y la reasigna en vez de chocar — no es una carrera de verdad, y un
 * test que dependa de ese timing es flaky. Acá se insertan las dos filas
 * ABIERTAS a propósito, con la segunda transacción bloqueada en el `INSERT`
 * hasta que la primera COMMITea, para que el choque sea 100% determinístico.
 * Que el error de Postgres (23505) se traduzca a un 409 claro ya está
 * probado con mutación en `vehicle-assignment.service.spec.ts` (mock) y en
 * `db-exceptions.spec.ts` (unit); acá se usa la MISMA función
 * (`traducirErrorDeBase`) contra el error REAL que devuelve Postgres.
 */
import { randomUUID } from 'crypto';
import { ConflictException, Logger } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { TestEnv, createTestApp, truncateAllTables } from './setup/test-env';
import { VehicleAssignment } from '../../src/car/entities/vehicle-assignment.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { User } from '../../src/users/entities/user.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Car } from '../../src/car/entities/car.entity';
import { traducirErrorDeBase } from '../../src/common/errors/db-exceptions';

describe('Vehículo en uso — invariante de base (e2e)', () => {
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

  async function seedChofer(distributorId: string) {
    const userRepo = dataSource.getRepository(User);
    const deliveryRepo = dataSource.getRepository(Delivery);
    const sufijo = randomUUID().slice(0, 8);

    const user = (await userRepo.save({
      email: `chofer.${sufijo}@test.local`,
      fullName: `Chofer ${sufijo}`,
      phoneNumber: `+549${sufijo.replace(/\D/g, '').padEnd(10, '0').slice(0, 10)}`,
    } as Partial<User>)) as User;

    const delivery = (await deliveryRepo.save({
      distributorId,
      userId: user.userId,
    } as Partial<Delivery>)) as Delivery;

    return { user, delivery };
  }

  async function seedCar(distributorId: string, userId: string) {
    const carRepo = dataSource.getRepository(Car);
    const patente = `TST${randomUUID().slice(0, 6).toUpperCase()}`;
    return (await carRepo.save({
      distributorId,
      userId,
      carPatent: patente,
    } as Partial<Car>)) as Car;
  }

  async function seedDistribuidora() {
    const distributorRepo = dataSource.getRepository(Distributor);
    return (await distributorRepo.save({
      name: 'Distribuidora Test',
      slug: `test-${randomUUID()}`,
    } as Partial<Distributor>)) as Distributor;
  }

  /**
   * Abre dos transacciones, inserta la primera fila y DEJA la segunda
   * bloqueada en el `INSERT` (Postgres toma el "value lock" del índice único
   * parcial apenas la primera inserta, antes de comitear); al comitear la
   * primera, la segunda se libera y recién ahí Postgres le devuelve el
   * choque. Limpia las dos conexiones al final, pase lo que pase.
   */
  async function chocanDosAsignacionesAbiertas(
    filaA: Partial<VehicleAssignment>,
    filaB: Partial<VehicleAssignment>,
  ): Promise<unknown> {
    const qr1 = dataSource.createQueryRunner();
    const qr2 = dataSource.createQueryRunner();
    await qr1.connect();
    await qr2.connect();
    await qr1.startTransaction();
    await qr2.startTransaction();

    let errorDeLaSegunda: unknown;
    try {
      await qr1.manager.insert(VehicleAssignment, filaA);

      const insertDeLaSegunda = qr2.manager
        .insert(VehicleAssignment, filaB)
        .catch((e: unknown) => {
          errorDeLaSegunda = e;
        });

      await qr1.commitTransaction();
      await insertDeLaSegunda;
    } finally {
      if (qr2.isTransactionActive) {
        await qr2.rollbackTransaction();
      }
      await qr1.release();
      await qr2.release();
    }
    return errorDeLaSegunda;
  }

  it('dos choferes no pueden tener el MISMO vehículo abierto a la vez: el que pierde la carrera recibe 409, no 500', async () => {
    const distributor = await seedDistribuidora();
    const { delivery: deliveryA, user } = await seedChofer(
      distributor.distributorId,
    );
    const { delivery: deliveryB } = await seedChofer(distributor.distributorId);
    const car = await seedCar(distributor.distributorId, user.userId);

    const base = {
      distributorId: distributor.distributorId,
      carId: car.carId,
      assignedAt: new Date(),
      releasedAt: null,
      assignedByUserId: user.userId,
      releasedByUserId: null,
      note: null,
    };

    const error = await chocanDosAsignacionesAbiertas(
      { ...base, deliveryId: deliveryA.deliveryId },
      { ...base, deliveryId: deliveryB.deliveryId },
    );

    expect(error).toBeDefined();
    expect(() => traducirErrorDeBase(error, new Logger('test'))).toThrow(
      ConflictException,
    );

    // La base nunca quedó con dos filas abiertas para el mismo auto.
    const abiertasDelAuto = await dataSource
      .getRepository(VehicleAssignment)
      .count({ where: { carId: car.carId, releasedAt: IsNull() } });
    expect(abiertasDelAuto).toBe(1);
  }, 30000);

  it('el MISMO chofer no puede tener dos vehículos abiertos a la vez: el que pierde la carrera recibe 409, no 500', async () => {
    const distributor = await seedDistribuidora();
    const { delivery, user } = await seedChofer(distributor.distributorId);
    const car1 = await seedCar(distributor.distributorId, user.userId);
    const car2 = await seedCar(distributor.distributorId, user.userId);

    const base = {
      distributorId: distributor.distributorId,
      deliveryId: delivery.deliveryId,
      assignedAt: new Date(),
      releasedAt: null,
      assignedByUserId: user.userId,
      releasedByUserId: null,
      note: null,
    };

    const error = await chocanDosAsignacionesAbiertas(
      { ...base, carId: car1.carId },
      { ...base, carId: car2.carId },
    );

    expect(error).toBeDefined();
    expect(() => traducirErrorDeBase(error, new Logger('test'))).toThrow(
      ConflictException,
    );

    const abiertasDelChofer = await dataSource
      .getRepository(VehicleAssignment)
      .count({
        where: { deliveryId: delivery.deliveryId, releasedAt: IsNull() },
      });
    expect(abiertasDelChofer).toBe(1);
  }, 30000);
});
