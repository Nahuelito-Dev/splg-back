/**
 * Tests de integración (Postgres real, testcontainers) de las reglas de
 * vehículo en uso, bajas, patentes, emails y stock: lo que los mocks de los
 * unit tests no pueden demostrar (transacciones, locks, rollback, SQL).
 */
import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  truncateAllTables,
  telefonoDePrueba,
  patenteDePrueba,
} from './setup/test-env';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { Car } from '../../src/car/entities/car.entity';
import { VehicleAssignment } from '../../src/car/entities/vehicle-assignment.entity';
import { VehicleAssignmentService } from '../../src/car/vehicle-assignment.service';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { OrderService } from '../../src/order/order.service';
import { UsersService } from '../../src/users/users.service';
import { CarService } from '../../src/car/car.service';
import { GasCylinderService } from '../../src/gascylinder/gascylinder.service';
import { Claim, ClaimStatus } from '../../src/claims/entities/claim.entity';
import { ClaimsService } from '../../src/claims/claims.service';
import { FleetTaskService } from '../../src/fleet/fleet-task.service';
import {
  MaintenanceCriticality,
  MaintenancePlan,
  MaintenanceSubject,
  MaintenanceTrigger,
} from '../../src/fleet/entities/maintenance-plan.entity';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from '../../src/fleet/entities/maintenance-task.entity';
import { fechasSegunEstado } from './setup/pedido-valido';
import { forzarEstado } from './setup/bypass';

describe('Reglas de vehículo en uso, bajas, patentes, emails y stock (e2e)', () => {
  let env: TestEnv;
  let dataSource: DataSource;
  let vehiculos: VehicleAssignmentService;
  let usuarios: UsersService;
  let autos: CarService;
  let productos: GasCylinderService;
  let reclamos: ClaimsService;
  let tareas: FleetTaskService;
  let pedidos: OrderService;

  beforeAll(async () => {
    env = await createTestApp();
    dataSource = env.app.get(DataSource);
    vehiculos = env.app.get(VehicleAssignmentService);
    usuarios = env.app.get(UsersService);
    autos = env.app.get(CarService);
    productos = env.app.get(GasCylinderService);
    reclamos = env.app.get(ClaimsService);
    tareas = env.app.get(FleetTaskService);
    pedidos = env.app.get(OrderService);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  async function seedDistribuidora() {
    return (await dataSource.getRepository(Distributor).save({
      name: 'Distribuidora Test',
      slug: `test-${randomUUID()}`,
    } as Partial<Distributor>)) as Distributor;
  }

  async function seedChofer(distributorId: string, email?: string) {
    const sufijo = randomUUID().slice(0, 8);
    const user = (await dataSource.getRepository(User).save({
      email: email ?? `chofer.${sufijo}@test.local`,
      fullName: `Chofer ${sufijo}`,
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>)) as User;
    const delivery = (await dataSource.getRepository(Delivery).save({
      distributorId,
      userId: user.userId,
    } as Partial<Delivery>)) as Delivery;
    return { user, delivery };
  }

  async function seedAuto(
    distributorId: string,
    userId: string,
    patente = patenteDePrueba(),
  ) {
    return (await dataSource.getRepository(Car).save({
      distributorId,
      userId,
      carPatent: patente,
      carBrand: 'Fiat',
      carModel: 'Fiorino',
    } as Partial<Car>)) as Car;
  }

  async function seedPedidoEnCurso(
    distributorId: string,
    deliveryId: string | null,
    status = OrderStatus.ACCEPTED,
  ) {
    const sufijo = randomUUID().slice(0, 8);
    const cliente = (await dataSource.getRepository(User).save({
      email: `cliente.${sufijo}@test.local`,
      fullName: 'Cliente Test',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>)) as User;
    await dataSource.getRepository(Customer).save({
      userId: cliente.userId,
      notificationToken: 'fake',
    } as Partial<Customer>);
    const address = (await dataSource.getRepository(UserAddress).save({
      userId: cliente.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>)) as UserAddress;
    const pedido = (await dataSource.getRepository(Order).save({
      customerId: cliente.userId,
      distributorId,
      addressId: address.addressId,
      status,
      paymentMethod: PaymentMethod.CASH,
      totalAmount: 1000,
      subtotalItems: 1000,
      deliveryId,
      ...fechasSegunEstado(status),
    } as Partial<Order>)) as Order;
    return { pedido, cliente };
  }

  const abiertas = (deliveryId: string) =>
    dataSource
      .getRepository(VehicleAssignment)
      .count({ where: { deliveryId, releasedAt: IsNull() } });

  describe('baja de usuario chofer (DELETE /users/:id)', () => {
    it('409 con un pedido aceptado: no se da de baja nada y el vehículo sigue en uso', async () => {
      const d = await seedDistribuidora();
      const { user, delivery } = await seedChofer(d.distributorId);
      const auto = await seedAuto(d.distributorId, user.userId);
      await vehiculos.ponerEnUso(
        delivery.deliveryId,
        auto.carId,
        null,
        d.distributorId,
        user.userId,
      );
      await seedPedidoEnCurso(d.distributorId, delivery.deliveryId);

      await expect(usuarios.remove(user.userId)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(await usuarios.findById(user.userId)).not.toBeNull();
      expect(await abiertas(delivery.deliveryId)).toBe(1);
    }, 30000);

    it('libera el vehículo en uso en la misma transacción de la baja', async () => {
      const d = await seedDistribuidora();
      const { user, delivery } = await seedChofer(d.distributorId);
      const auto = await seedAuto(d.distributorId, user.userId);
      await vehiculos.ponerEnUso(
        delivery.deliveryId,
        auto.carId,
        null,
        d.distributorId,
        user.userId,
      );

      await usuarios.remove(user.userId);

      expect(await usuarios.findById(user.userId)).toBeNull();
      expect(await abiertas(delivery.deliveryId)).toBe(0);
    }, 30000);

    it('si liberar el vehículo falla, la baja se revierte: el usuario sigue vivo', async () => {
      const d = await seedDistribuidora();
      const { user, delivery } = await seedChofer(d.distributorId);
      const auto = await seedAuto(d.distributorId, user.userId);
      await vehiculos.ponerEnUso(
        delivery.deliveryId,
        auto.carId,
        null,
        d.distributorId,
        user.userId,
      );
      const espia = jest
        .spyOn(vehiculos, 'liberarSiTieneUno')
        .mockRejectedValueOnce(new Error('falla al liberar'));

      await expect(usuarios.remove(user.userId)).rejects.toThrow(
        'falla al liberar',
      );
      espia.mockRestore();

      expect(await usuarios.findById(user.userId)).not.toBeNull();
      expect(await abiertas(delivery.deliveryId)).toBe(1);
      const chofer = await dataSource
        .getRepository(Delivery)
        .findOne({ where: { deliveryId: delivery.deliveryId } });
      expect(chofer).not.toBeNull();
    }, 30000);
  });

  describe('vehículo en uso', () => {
    it('poner el mismo vehículo dos veces es idempotente: una sola fila en el historial', async () => {
      const d = await seedDistribuidora();
      const { user, delivery } = await seedChofer(d.distributorId);
      const auto = await seedAuto(d.distributorId, user.userId);

      const primera = await vehiculos.ponerEnUso(
        delivery.deliveryId,
        auto.carId,
        null,
        d.distributorId,
        user.userId,
      );
      const segunda = await vehiculos.ponerEnUso(
        delivery.deliveryId,
        auto.carId,
        null,
        d.distributorId,
        user.userId,
      );

      expect(segunda.assignmentId).toBe(primera.assignmentId);
      const filas = await dataSource
        .getRepository(VehicleAssignment)
        .find({ where: { deliveryId: delivery.deliveryId } });
      expect(filas).toHaveLength(1);
      expect(filas[0].releasedAt).toBeNull();
    }, 30000);

    it('no se cambia el vehículo de un chofer con un pedido en curso (409), y un vehículo ajeno inexistente es 404 en castellano', async () => {
      const d = await seedDistribuidora();
      const { user, delivery } = await seedChofer(d.distributorId);
      const auto1 = await seedAuto(d.distributorId, user.userId);
      const auto2 = await seedAuto(d.distributorId, user.userId);
      await vehiculos.ponerEnUso(
        delivery.deliveryId,
        auto1.carId,
        null,
        d.distributorId,
        user.userId,
      );
      await seedPedidoEnCurso(d.distributorId, delivery.deliveryId);

      await expect(
        vehiculos.ponerEnUso(
          delivery.deliveryId,
          auto2.carId,
          null,
          d.distributorId,
          user.userId,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        vehiculos.liberar(delivery.deliveryId, d.distributorId, user.userId),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        vehiculos.ponerEnUso(
          delivery.deliveryId,
          randomUUID(),
          null,
          d.distributorId,
          user.userId,
        ),
      ).rejects.toThrow(/Vehículo .* no encontrado/);
      expect(await abiertas(delivery.deliveryId)).toBe(1);
    }, 30000);

    it('el historial conserva patente, marca, modelo y nombre aunque el vehículo y el chofer estén dados de baja', async () => {
      const d = await seedDistribuidora();
      const { user, delivery } = await seedChofer(d.distributorId);
      const auto = await seedAuto(d.distributorId, user.userId, 'ZZ999ZZ');
      await vehiculos.ponerEnUso(
        delivery.deliveryId,
        auto.carId,
        null,
        d.distributorId,
        user.userId,
      );
      await usuarios.remove(user.userId); // baja del chofer (libera el vehículo)
      await autos.remove(auto.carId, d.distributorId); // baja del vehículo

      const [porVehiculo] = await vehiculos.historialDelVehiculo(
        auto.carId,
        d.distributorId,
        {},
      );
      expect(porVehiculo).toHaveLength(1);
      expect(porVehiculo[0].car.carPatent).toBe('ZZ999ZZ');
      expect(porVehiculo[0].delivery.user.fullName).toBe(user.fullName);
    }, 30000);

    it('el historial del chofer trae el vehículo dado de baja', async () => {
      const d = await seedDistribuidora();
      const { user, delivery } = await seedChofer(d.distributorId);
      const auto = await seedAuto(d.distributorId, user.userId, 'YY888YY');
      await vehiculos.ponerEnUso(
        delivery.deliveryId,
        auto.carId,
        null,
        d.distributorId,
        user.userId,
      );
      await vehiculos.liberar(
        delivery.deliveryId,
        d.distributorId,
        user.userId,
      );
      await autos.remove(auto.carId, d.distributorId);

      const [filas] = await vehiculos.historialDelChofer(
        delivery.deliveryId,
        d.distributorId,
        {},
      );
      expect(filas).toHaveLength(1);
      expect(filas[0].car.carPatent).toBe('YY888YY');
      expect(filas[0].car.carBrand).toBe('Fiat');
      expect(filas[0].delivery.user.fullName).toBe(user.fullName);
    }, 30000);
  });

  describe('patentes', () => {
    it('se guardan normalizadas y "ab 123-cd" choca con "AB123CD"', async () => {
      const d = await seedDistribuidora();
      const { user } = await seedChofer(d.distributorId);

      const creado = await autos.create(
        { user_id: user.userId, car_patent: 'ab 123-cd' },
        d.distributorId,
      );
      expect(creado.carPatent).toBe('AB123CD');

      await expect(
        autos.create(
          { user_id: user.userId, car_patent: 'AB-123 CD' },
          d.distributorId,
        ),
      ).rejects.toThrow('La patente del vehículo ya está registrada');

      const encontrado = await autos.findByPatent('ab 123 cd', d.distributorId);
      expect(encontrado?.carId).toBe(creado.carId);
    }, 30000);
  });

  describe('emails sin distinguir mayúsculas', () => {
    it('checkUserExists, findOneByEmail y el alta reconocen el mismo correo en otra capitalización', async () => {
      const d = await seedDistribuidora();
      await seedChofer(d.distributorId, 'Ana.Perez@Test.local');

      await expect(
        usuarios.checkUserExists('ana.perez@test.local'),
      ).resolves.toMatchObject({ exists: true, email: true });
      await expect(
        usuarios.checkUserExists('ANA.PEREZ@TEST.LOCAL'),
      ).resolves.toMatchObject({ exists: true, email: true });
      await expect(
        usuarios.checkUserExists('otra@test.local'),
      ).resolves.toMatchObject({ exists: false });

      const encontrado = await usuarios.findOneByEmail('ana.perez@TEST.local');
      expect(encontrado.email).toBe('Ana.Perez@Test.local');
      await expect(
        usuarios.assertDisponible('ANA.PEREZ@test.local', '+5490000000000'),
      ).rejects.toBeInstanceOf(ConflictException);
    }, 30000);

    it('un usuario dado de baja ocupa el correo y el teléfono: el pre-registro y el alta dicen lo mismo', async () => {
      const d = await seedDistribuidora();
      const { user } = await seedChofer(d.distributorId, 'baja@test.local');
      await usuarios.remove(user.userId);

      await expect(
        usuarios.checkUserExists('baja@test.local', user.phoneNumber),
      ).resolves.toEqual({ exists: true, email: true, phoneNumber: true });
      await expect(
        usuarios.assertDisponible('baja@test.local', '+5490000000001'),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        usuarios.assertDisponible(
          'libre@test.local',
          user.phoneNumber as string,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    }, 30000);

    it('el guion bajo del correo no actúa como comodín', async () => {
      const d = await seedDistribuidora();
      await seedChofer(d.distributorId, 'a_b@test.local');
      await expect(
        usuarios.checkUserExists('axb@test.local'),
      ).resolves.toMatchObject({ exists: false });
    }, 30000);
  });

  describe('stock del catálogo', () => {
    it('updateStock en paralelo no pierde actualizaciones', async () => {
      const d = await seedDistribuidora();
      const producto = (await dataSource.getRepository(GasCylinder).save({
        type: '10kg',
        price: 1000,
        stock: 0,
        weight: 10,
        isActive: true,
        distributorId: d.distributorId,
      } as Partial<GasCylinder>)) as GasCylinder;

      await Promise.all(
        Array.from({ length: 15 }, () =>
          productos.updateStock(producto.gasCylinderId, 1, d.distributorId),
        ),
      );

      const final = await dataSource
        .getRepository(GasCylinder)
        .findOneByOrFail({ gasCylinderId: producto.gasCylinderId });
      expect(final.stock).toBe(15);
    }, 30000);

    it('updateStock contra reservarStock en paralelo conserva las dos operaciones', async () => {
      const d = await seedDistribuidora();
      const producto = (await dataSource.getRepository(GasCylinder).save({
        type: '10kg',
        price: 1000,
        stock: 100,
        weight: 10,
        isActive: true,
        distributorId: d.distributorId,
      } as Partial<GasCylinder>)) as GasCylinder;

      await Promise.all([
        ...Array.from({ length: 10 }, () =>
          productos.updateStock(producto.gasCylinderId, 2, d.distributorId),
        ),
        ...Array.from({ length: 10 }, () =>
          dataSource.transaction((m) =>
            productos.reservarStock(m, producto.gasCylinderId, 1),
          ),
        ),
      ]);

      const final = await dataSource
        .getRepository(GasCylinder)
        .findOneByOrFail({ gasCylinderId: producto.gasCylinderId });
      expect(final.stock).toBe(100 + 20 - 10);
    }, 30000);
  });

  describe('reclamos: transiciones concurrentes', () => {
    it('dos resoluciones simultáneas: gana una, la otra ve el estado nuevo y es 400 (no pisa la nota)', async () => {
      const d = await seedDistribuidora();
      const { delivery } = await seedChofer(d.distributorId);
      const { pedido, cliente } = await seedPedidoEnCurso(
        d.distributorId,
        delivery.deliveryId,
      );
      const reclamo = (await dataSource.getRepository(Claim).save({
        orderId: pedido.orderId,
        customerId: cliente.userId,
        distributorId: d.distributorId,
        reason: 'Fuga',
        description: 'Pierde gas',
      } as Partial<Claim>)) as Claim;

      const resultados = await Promise.allSettled([
        reclamos.resolve(
          reclamo.claimId,
          'nota A',
          ClaimStatus.RESOLVED,
          d.distributorId,
        ),
        reclamos.resolve(
          reclamo.claimId,
          'nota B',
          ClaimStatus.REJECTED,
          d.distributorId,
        ),
      ]);

      const ok = resultados.filter((r) => r.status === 'fulfilled');
      const falla = resultados.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(falla).toHaveLength(1);
      expect(falla[0].reason).toBeInstanceOf(BadRequestException);
      const final = await dataSource
        .getRepository(Claim)
        .findOneByOrFail({ claimId: reclamo.claimId });
      const ganador = ok[0].value;
      expect(final.resolutionNote).toBe(ganador.resolutionNote);
      expect(final.status).toBe(ganador.status);
    }, 30000);
  });

  describe('editar un vehículo en uso', () => {
    it('la patente y el tipo no se tocan en uso (409); el resto sí; libre se edita todo', async () => {
      const d = await seedDistribuidora();
      const { user, delivery } = await seedChofer(d.distributorId);
      const auto = await seedAuto(d.distributorId, user.userId, 'AAA111');
      await vehiculos.ponerEnUso(
        delivery.deliveryId,
        auto.carId,
        null,
        d.distributorId,
        user.userId,
      );

      await expect(
        autos.update(auto.carId, { car_patent: 'BBB222' }, d.distributorId),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        autos.update(auto.carId, { type_car: 'Moto' }, d.distributorId),
      ).rejects.toBeInstanceOf(ConflictException);
      const sinCambios = await dataSource
        .getRepository(Car)
        .findOneByOrFail({ carId: auto.carId });
      expect(sinCambios.carPatent).toBe('AAA111');

      await autos.update(auto.carId, { car_color: 'Rojo' }, d.distributorId);

      await vehiculos.liberar(
        delivery.deliveryId,
        d.distributorId,
        user.userId,
      );
      const editado = await autos.update(
        auto.carId,
        { car_patent: 'BBB222', type_car: 'Moto' },
        d.distributorId,
      );
      expect(editado.carPatent).toBe('BBB222');
      expect(editado.typeCar).toBe('Moto');
    }, 30000);
  });

  describe('baja de vehículo atómica', () => {
    it('si otra transacción tiene bloqueado el vehículo y lo deja en uso, la baja espera y responde 409', async () => {
      const d = await seedDistribuidora();
      const { user, delivery } = await seedChofer(d.distributorId);
      const auto = await seedAuto(d.distributorId, user.userId);

      // Hace de `ponerEnUso` a medio camino: lock del vehículo + asignación
      // abierta todavía sin confirmar.
      const qr = dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      let baja: Promise<unknown> | undefined;
      try {
        await qr.query('SELECT 1 FROM "car" WHERE car_id = $1 FOR UPDATE', [
          auto.carId,
        ]);
        await qr.manager.insert(VehicleAssignment, {
          distributorId: d.distributorId,
          carId: auto.carId,
          deliveryId: delivery.deliveryId,
          assignedAt: new Date(),
          assignedByUserId: user.userId,
        });

        baja = autos
          .remove(auto.carId, d.distributorId)
          .then(() => 'borrado' as const)
          .catch((e: unknown) => e);
        await new Promise((r) => setTimeout(r, 400));
        await qr.commitTransaction();
      } finally {
        if (qr.isTransactionActive) await qr.rollbackTransaction();
        await qr.release();
      }

      expect(await baja).toBeInstanceOf(ConflictException);
      const vigente = await dataSource
        .getRepository(Car)
        .findOneBy({ carId: auto.carId });
      expect(vigente).not.toBeNull();
    }, 30000);

    it('si la baja gana el lock, poner ese vehículo en uso es 404', async () => {
      const d = await seedDistribuidora();
      const { user, delivery } = await seedChofer(d.distributorId);
      const auto = await seedAuto(d.distributorId, user.userId);

      await autos.remove(auto.carId, d.distributorId);

      await expect(
        vehiculos.ponerEnUso(
          delivery.deliveryId,
          auto.carId,
          null,
          d.distributorId,
          user.userId,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await abiertas(delivery.deliveryId)).toBe(0);
    }, 30000);
  });

  describe('chofer inexistente o de otra distribuidora', () => {
    it('responden el MISMO 404 en castellano: no se puede saber si existe en otro tenant', async () => {
      const d1 = await seedDistribuidora();
      const d2 = await seedDistribuidora();
      const { delivery: ajeno } = await seedChofer(d2.distributorId);
      const inexistente = randomUUID();

      const mensaje = async (deliveryId: string) => {
        const error = await vehiculos
          .assertChoferDelTenant(deliveryId, d1.distributorId)
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(error).toBeInstanceOf(NotFoundException);
        return (error as NotFoundException).message.replace(deliveryId, 'ID');
      };

      const deInexistente = await mensaje(inexistente);
      const deAjeno = await mensaje(ajeno.deliveryId);
      expect(deInexistente).toBe('Chofer ID no encontrado');
      expect(deAjeno).toBe(deInexistente);
    }, 30000);
  });

  describe('GET /fleet/tasks: orden estable, total y planId', () => {
    it('NULLS LAST con desempate por id: paginar de a 2 no repite ni salta filas', async () => {
      const d = await seedDistribuidora();
      const planes = dataSource.getRepository(MaintenancePlan);
      const plan = (await planes.save({
        distributorId: d.distributorId,
        name: 'VTV',
        subject: MaintenanceSubject.VEHICLE,
        trigger: MaintenanceTrigger.BY_FIXED_DATE,
        leadTimeDays: 30,
        criticality: MaintenanceCriticality.BLOCKING,
      } as Partial<MaintenancePlan>)) as MaintenancePlan;
      const otroPlan = (await planes.save({
        distributorId: d.distributorId,
        name: 'Seguro',
        subject: MaintenanceSubject.VEHICLE,
        trigger: MaintenanceTrigger.BY_FIXED_DATE,
        leadTimeDays: 30,
        criticality: MaintenanceCriticality.BLOCKING,
      } as Partial<MaintenancePlan>)) as MaintenancePlan;
      const mismaFecha = new Date('2030-01-01T00:00:00Z');
      // Toda tarea es de un sujeto (CHK_maintenance_task_un_sujeto): un vehículo.
      const { user } = await seedChofer(d.distributorId);
      const auto = await seedAuto(d.distributorId, user.userId);
      const repo = dataSource.getRepository(MaintenanceTask);
      const nueva = (planId: string, dueAt: Date | null) =>
        repo.save({
          planId,
          distributorId: d.distributorId,
          carId: auto.carId,
          status: MaintenanceTaskStatus.FORECAST,
          dueAt,
        } as Partial<MaintenanceTask>);
      for (const dueAt of [null, mismaFecha, null, mismaFecha, null]) {
        await nueva(plan.planId, dueAt);
      }
      await nueva(otroPlan.planId, mismaFecha);

      const ids: string[] = [];
      const paginas: MaintenanceTask[][] = [];
      for (let offset = 0; offset < 5; offset += 2) {
        const [pagina, total] = await tareas.findAll(d.distributorId, {
          planId: plan.planId,
          limit: 2,
          offset,
        });
        expect(total).toBe(5);
        ids.push(...pagina.map((t) => t.taskId));
        paginas.push(pagina);
      }
      // NULLS LAST: la primera página trae las dos tareas con fecha
      expect(paginas[0].map((t) => t.dueAt !== null)).toEqual([true, true]);
      expect(new Set(ids).size).toBe(5);

      const [todas] = await tareas.findAll(d.distributorId, {
        planId: plan.planId,
        limit: 10,
      });
      expect(todas.map((t) => t.taskId)).toEqual(ids);
      // Con vencimiento primero, sin vencimiento al final.
      expect(todas.map((t) => t.dueAt !== null)).toEqual([
        true,
        true,
        false,
        false,
        false,
      ]);
      const [sinFiltro, totalSinFiltro] = await tareas.findAll(
        d.distributorId,
        {},
      );
      expect(totalSinFiltro).toBe(6);
      expect(sinFiltro).toHaveLength(6);
    }, 30000);
  });

  describe('el lock del chofer: baja contra poner vehículo y contra aceptación', () => {
    /**
     * Hace de "otra operación a medio camino": toma el lock del chofer en su
     * propia transacción, ejecuta `escribir` sin confirmar, dispara `operacion`
     * (que tiene que quedar esperando el lock) y recién entonces confirma.
     */
    async function conOperacionEnCurso<T>(
      deliveryId: string,
      escribir: (
        qr: ReturnType<DataSource['createQueryRunner']>,
      ) => Promise<void>,
      operacion: () => Promise<T>,
    ): Promise<{ resultado: PromiseSettledResult<T> }> {
      const qr = dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      let pendiente: Promise<PromiseSettledResult<T>> | undefined;
      try {
        await qr.query(
          'SELECT 1 FROM "delivery" WHERE delivery_id = $1 FOR NO KEY UPDATE',
          [deliveryId],
        );
        await escribir(qr);
        pendiente = Promise.allSettled([operacion()]).then((r) => r[0]);
        await new Promise((r) => setTimeout(r, 500));
        await qr.commitTransaction();
      } finally {
        if (qr.isTransactionActive) await qr.rollbackTransaction();
        await qr.release();
      }
      return {
        resultado: await pendiente,
      };
    }

    it('poner el vehículo contra la baja del chofer: la baja gana y el chofer es 404, sin asignación', async () => {
      const d = await seedDistribuidora();
      const { user, delivery } = await seedChofer(d.distributorId);
      const auto = await seedAuto(d.distributorId, user.userId);

      const { resultado } = await conOperacionEnCurso(
        delivery.deliveryId,
        async (qr) => {
          await qr.query(
            'UPDATE "delivery" SET "deletedAt" = now() WHERE delivery_id = $1',
            [delivery.deliveryId],
          );
        },
        () =>
          vehiculos.ponerEnUso(
            delivery.deliveryId,
            auto.carId,
            null,
            d.distributorId,
            user.userId,
          ),
      );

      expect(resultado.status).toBe('rejected');
      expect((resultado as PromiseRejectedResult).reason).toBeInstanceOf(
        NotFoundException,
      );
      const filas = await dataSource
        .getRepository(VehicleAssignment)
        .count({ where: { deliveryId: delivery.deliveryId } });
      expect(filas).toBe(0);
    }, 30000);

    it('la baja del usuario contra una aceptación en curso: espera el lock, ve el pedido aceptado y es 409', async () => {
      const d = await seedDistribuidora();
      const { user, delivery } = await seedChofer(d.distributorId);
      const { pedido } = await seedPedidoEnCurso(
        d.distributorId,
        null,
        OrderStatus.PENDING,
      );

      const { resultado } = await conOperacionEnCurso(
        delivery.deliveryId,
        async (qr) => {
          await forzarEstado(
            qr,
            `UPDATE "order" SET status = 'accepted', delivery_id = $1, "acceptedAt" = now() WHERE order_id = $2`,
            [delivery.deliveryId, pedido.orderId],
          );
        },
        () => usuarios.remove(user.userId),
      );

      expect(resultado.status).toBe('rejected');
      expect((resultado as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );
      expect(await usuarios.findById(user.userId)).not.toBeNull();
    }, 30000);

    it('la asignación a mano de un pedido contra la baja del chofer: la baja gana y es 404', async () => {
      const d = await seedDistribuidora();
      const { user, delivery } = await seedChofer(d.distributorId);
      await dataSource
        .getRepository(Delivery)
        .update(
          { deliveryId: delivery.deliveryId },
          { validated: true, isEnabled: true },
        );
      const auto = await seedAuto(d.distributorId, user.userId);
      await vehiculos.ponerEnUso(
        delivery.deliveryId,
        auto.carId,
        null,
        d.distributorId,
        user.userId,
      );
      const { pedido } = await seedPedidoEnCurso(
        d.distributorId,
        null,
        OrderStatus.PENDING,
      );

      const { resultado } = await conOperacionEnCurso(
        delivery.deliveryId,
        async (qr) => {
          await qr.query(
            'UPDATE "delivery" SET "deletedAt" = now() WHERE delivery_id = $1',
            [delivery.deliveryId],
          );
        },
        () => pedidos.assignDelivery(pedido.orderId, delivery.deliveryId),
      );

      expect(resultado.status).toBe('rejected');
      expect((resultado as PromiseRejectedResult).reason).toBeInstanceOf(
        NotFoundException,
      );
      const guardado = await dataSource
        .getRepository(Order)
        .findOneByOrFail({ orderId: pedido.orderId });
      expect(guardado.status).toBe(OrderStatus.PENDING);
    }, 30000);
  });
});
