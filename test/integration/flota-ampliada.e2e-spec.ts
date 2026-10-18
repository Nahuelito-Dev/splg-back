/**
 * Flota ampliada (C-18) contra la API con Postgres real: cargas de
 * combustible y su consumo, la habilitación de mercancías peligrosas, multas,
 * siniestros, neumáticos, costo por vehículo, tablero de flota y reactivación,
 * cada uno con su caso de error y el de otra distribuidora.
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
import { Admin } from '../../src/admin/entities/admin.entity';
import { Car, FleetStatus } from '../../src/car/entities/car.entity';
import { VehicleAssignment } from '../../src/car/entities/vehicle-assignment.entity';
import { diaArgentino } from '../../src/common/utils/dias-argentina';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { DistribuidoraCreadaEvent } from '../../src/distributor/events/distribuidora-creada.event';
import { EmailSenderPort } from '../../src/email/ports/email-sender.port';
import {
  Employee,
  EmploymentType,
  EmployeeDocumentType,
} from '../../src/employee/entities/employee.entity';
import {
  JobPosition,
  JobPositionCategory,
} from '../../src/employee/entities/job-position.entity';
import { JobPositionService } from '../../src/employee/job-position.service';
import {
  MaintenancePlan,
  MaintenanceDocumentKind,
} from '../../src/fleet/entities/maintenance-plan.entity';
import { FleetPlanSeedListener } from '../../src/fleet/fleet-plan-seed.listener';
import { FineDueAlertsCron } from '../../src/fleet-expense/fine-due-alerts.cron';
import { TrafficFine } from '../../src/fleet-expense/entities/traffic-fine.entity';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';

type Cuerpo = Record<string, unknown>;
type Headers = Record<string, string>;

const DIA_EN_MS = 86_400_000;
const haceDias = (n: number) => new Date(Date.now() - n * DIA_EN_MS);
const sumarDias = (dia: string, n: number) =>
  new Date(Date.parse(`${dia}T00:00:00.000Z`) + n * DIA_EN_MS)
    .toISOString()
    .slice(0, 10);

describe('Flota ampliada C-18 (e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let enviados: Array<{ to: string; subject: string; html: string }>;
  let envioFalla: boolean;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    jest
      .spyOn(env.app.get(EmailSenderPort), 'send')
      .mockImplementation((mail) => {
        if (envioFalla) return Promise.reject(new Error('smtp caído'));
        enviados.push(mail);
        return Promise.resolve();
      });
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
    enviados = [];
    envioFalla = false;
  });

  const http = () => request(env.app.getHttpServer());
  const cuerpoDe = <T = Cuerpo>(res: { body: unknown }) => res.body as T;

  async function rol(type: string): Promise<Role> {
    const roles = ds.getRepository(Role);
    return (
      (await roles.findOne({ where: { type } })) ??
      (await roles.save({ type } as Partial<Role>))
    );
  }

  let seq = 0;

  async function seedDistribuidora() {
    seq++;
    const sufijo = `${seq}-${randomUUID().slice(0, 6)}`;
    const dist = (await ds.getRepository(Distributor).save({
      name: `Dist ${sufijo}`,
      slug: `dist-${sufijo}`,
    } as Partial<Distributor>)) as Distributor;
    await env.app.get(JobPositionService).sembrarBase(dist.distributorId);
    // Los planes base (incluida la habilitación de mercancías peligrosas).
    await env.app
      .get(FleetPlanSeedListener)
      .handle(new DistribuidoraCreadaEvent(dist.distributorId));
    const email = `admin.${sufijo}@splg.local`;
    const user = (await ds.getRepository(User).save({
      email,
      fullName: 'Admin Test',
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol('admin')).roleId,
    } as Partial<User>)) as User;
    await ds.getRepository(Admin).save({
      userId: user.userId,
      distributorId: dist.distributorId,
    } as Partial<Admin>);
    return {
      distributorId: dist.distributorId,
      adminEmail: email,
      admin: {
        Authorization: `Bearer ${email}`,
        'X-Client-Source': 'panel-app',
      } as Headers,
    };
  }
  type Dist = Awaited<ReturnType<typeof seedDistribuidora>>;

  /** Un vehículo (con su dueño chofer, legajo y asignación en uso opcional). */
  async function seedChoferConAuto(
    d: Dist,
    opts: { enUso?: boolean; asignadoHace?: number } = {},
  ) {
    seq++;
    const sufijo = `${seq}-${randomUUID().slice(0, 6)}`;
    const email = `chofer.${sufijo}@splg.local`;
    const user = (await ds.getRepository(User).save({
      email,
      fullName: `Chofer ${seq}`,
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol('delivery')).roleId,
    } as Partial<User>)) as User;
    const delivery = (await ds.getRepository(Delivery).save({
      userId: user.userId,
      distributorId: d.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>)) as Delivery;
    const puesto = await ds.getRepository(JobPosition).findOneOrFail({
      where: {
        distributorId: d.distributorId,
        category: JobPositionCategory.DRIVER,
      },
    });
    const legajo = (await ds.getRepository(Employee).save({
      distributorId: d.distributorId,
      userId: user.userId,
      positionId: puesto.positionId,
      fileNumber: `L${seq}`,
      firstName: 'Carlos',
      lastName: `Chofer${seq}`,
      documentType: EmployeeDocumentType.DNI,
      documentNumber: `4000${String(seq).padStart(4, '0')}`,
      hireDate: '2026-01-01',
      employmentType: EmploymentType.PERMANENT,
    } as Partial<Employee>)) as Employee;
    const auto = (await ds.getRepository(Car).save({
      distributorId: d.distributorId,
      userId: user.userId,
      carPatent: `F${seq}${randomUUID().slice(0, 4).toUpperCase()}`,
      carBrand: 'Fiat',
      carModel: 'Fiorino',
      fuelType: 'diesel',
      tankCapacityLiters: 60,
      odometerKm: 0,
    } as unknown as Partial<Car>)) as Car;
    if (opts.enUso !== false) {
      await ds.getRepository(VehicleAssignment).save({
        distributorId: d.distributorId,
        carId: auto.carId,
        deliveryId: delivery.deliveryId,
        assignedAt: haceDias(opts.asignadoHace ?? 5),
      } as Partial<VehicleAssignment>);
    }
    return {
      userId: user.userId,
      deliveryId: delivery.deliveryId,
      employeeId: legajo.employeeId,
      carId: auto.carId,
      headers: {
        Authorization: `Bearer ${email}`,
        'X-Client-Source': 'delivery-app',
      } as Headers,
    };
  }
  type Chofer = Awaited<ReturnType<typeof seedChoferConAuto>>;

  async function escenario() {
    const d1 = await seedDistribuidora();
    const d2 = await seedDistribuidora();
    const c1 = await seedChoferConAuto(d1);
    const c2 = await seedChoferConAuto(d2);
    return { d1, d2, c1, c2 };
  }

  const autoDe = (carId: string) =>
    ds.getRepository(Car).findOneOrFail({ where: { carId } });

  // ---------------------------------------------------------------------
  // Combustible: CU-195, CU-320, CU-321, CU-322, CU-196
  // ---------------------------------------------------------------------
  describe('cargas de combustible', () => {
    const carga = (carId: string, over: Cuerpo = {}) => ({
      carId,
      liters: 40,
      unitPrice: 1000,
      totalAmount: 40000,
      odometerKm: 1000,
      paymentMethod: 'card',
      ...over,
    });

    const postCarga = (h: Headers, body: Cuerpo) =>
      http().post('/fleet/fuel-loads').set(h).send(body);

    it('CU-195: registra la carga con el combustible del vehículo y sube su kilometraje', async () => {
      const { d1, c1 } = await escenario();
      const res = await postCarga(d1.admin, carga(c1.carId)).expect(201);
      const dto = cuerpoDe(res);
      expect(dto).toMatchObject({
        carId: c1.carId,
        fuelType: 'diesel',
        liters: 40,
        totalAmount: 40000,
        isFullTank: true,
        anomaly: false,
        employeeId: c1.employeeId,
      });
      expect((await autoDe(c1.carId)).odometerKm).toBe(1000);
    });

    it('CU-195: un importe que no coincide con litros × precio es 400 con el campo', async () => {
      const { d1, c1 } = await escenario();
      const res = await postCarga(
        d1.admin,
        carga(c1.carId, { totalAmount: 41000 }),
      ).expect(400);
      expect(JSON.stringify(res.body)).toContain('totalAmount');
      // 1 % de tolerancia: 40399 pasa
      await postCarga(d1.admin, carga(c1.carId, { totalAmount: 40399 })).expect(
        201,
      );
    });

    it('CU-195: los litros no superan en más de 5 % la capacidad del tanque', async () => {
      const { d1, c1 } = await escenario();
      const res = await postCarga(
        d1.admin,
        carga(c1.carId, { liters: 64, totalAmount: 64000 }),
      ).expect(400);
      expect(JSON.stringify(res.body)).toContain('liters');
      await postCarga(
        d1.admin,
        carga(c1.carId, { liters: 63, totalAmount: 63000 }),
      ).expect(201);
    });

    it('CU-195: sin combustible en la carga ni en el vehículo es 400', async () => {
      const { d1, c1 } = await escenario();
      await ds
        .getRepository(Car)
        .update({ carId: c1.carId }, { fuelType: null });
      const res = await postCarga(d1.admin, carga(c1.carId)).expect(400);
      expect(JSON.stringify(res.body)).toContain('fuelType');
      await postCarga(
        d1.admin,
        carga(c1.carId, { fuelType: 'gasoline' }),
      ).expect(201);
    });

    it('CU-195: el kilometraje no puede ser menor que el de la última carga; el administrador lo fuerza con una nota', async () => {
      const { d1, c1 } = await escenario();
      await postCarga(
        d1.admin,
        carga(c1.carId, { loadedAt: haceDias(2).toISOString() }),
      ).expect(201);

      const res = await postCarga(
        d1.admin,
        carga(c1.carId, { odometerKm: 900 }),
      ).expect(400);
      expect(JSON.stringify(res.body)).toContain(
        'El kilometraje es menor que el de la última carga',
      );

      // forzar sin nota: 400
      await postCarga(
        d1.admin,
        carga(c1.carId, { odometerKm: 900, odometerCorrection: true }),
      ).expect(400);

      const forzada = await postCarga(
        d1.admin,
        carga(c1.carId, {
          odometerKm: 900,
          odometerCorrection: true,
          odometerCorrectionNote: 'Se cambió el tablero',
        }),
      ).expect(201);
      expect(cuerpoDe(forzada).odometerCorrectionNote).toBe(
        'Se cambió el tablero',
      );
      // el kilometraje del vehículo es el mayor: no baja
      expect((await autoDe(c1.carId)).odometerKm).toBe(1000);
    });

    it('CU-195: el chofer registra la de su vehículo en uso, sin poder forzar el kilometraje', async () => {
      const { c1 } = await escenario();
      const res = await http()
        .post('/fleet/fuel-loads/mine')
        .set(c1.headers)
        .send({
          liters: 30,
          unitPrice: 1000,
          totalAmount: 30000,
          odometerKm: 500,
          paymentMethod: 'driver_cash',
        })
        .expect(201);
      expect(cuerpoDe(res)).toMatchObject({
        carId: c1.carId,
        employeeId: c1.employeeId,
      });

      await http()
        .post('/fleet/fuel-loads/mine')
        .set(c1.headers)
        .send({
          liters: 30,
          unitPrice: 1000,
          totalAmount: 30000,
          odometerKm: 100,
          paymentMethod: 'driver_cash',
          odometerCorrection: true,
          odometerCorrectionNote: 'x',
        })
        .expect(400);

      // el chofer no entra al registro del administrador
      await http()
        .post('/fleet/fuel-loads')
        .set(c1.headers)
        .send(carga(c1.carId))
        .expect(403);
    });

    it('CU-195: un chofer sin vehículo en uso recibe «No tenés un vehículo en uso»', async () => {
      const d1 = await seedDistribuidora();
      const sinAuto = await seedChoferConAuto(d1, { enUso: false });
      const res = await http()
        .post('/fleet/fuel-loads/mine')
        .set(sinAuto.headers)
        .send({
          liters: 30,
          unitPrice: 1000,
          totalAmount: 30000,
          odometerKm: 500,
          paymentMethod: 'card',
        })
        .expect(404);
      expect(JSON.stringify(res.body)).toContain('No tenés un vehículo en uso');
    });

    it('otra distribuidora: no puede cargar, ver, modificar ni anular (404)', async () => {
      const { d1, d2, c1 } = await escenario();
      const creada = cuerpoDe<{ fuelLoadId: string }>(
        await postCarga(d1.admin, carga(c1.carId)).expect(201),
      );
      await postCarga(d2.admin, carga(c1.carId)).expect(404);
      await http()
        .get(`/fleet/fuel-loads/${creada.fuelLoadId}`)
        .set(d2.admin)
        .expect(404);
      await http()
        .patch(`/fleet/fuel-loads/${creada.fuelLoadId}`)
        .set(d2.admin)
        .send({ station: 'x' })
        .expect(404);
      await http()
        .delete(`/fleet/fuel-loads/${creada.fuelLoadId}`)
        .set(d2.admin)
        .expect(404);
      await http()
        .get(`/cars/${c1.carId}/fuel-efficiency?from=2026-01-01&to=2026-12-31`)
        .set(d2.admin)
        .expect(404);
      const lista = await http()
        .get('/fleet/fuel-loads')
        .set(d2.admin)
        .expect(200);
      expect(cuerpoDe(lista)).toMatchObject({ data: [], total: 0 });
    });

    it('CU-195: una carga con consumo anómalo se marca y avisa a los administradores', async () => {
      const { d1, c1 } = await escenario();
      // siete cargas llenas a 10 km/L, cada 400 km
      for (let i = 0; i < 7; i++) {
        await postCarga(
          d1.admin,
          carga(c1.carId, {
            odometerKm: i * 400,
            loadedAt: haceDias(20 - i).toISOString(),
          }),
        ).expect(201);
      }
      expect(enviados).toHaveLength(0);

      // 400 km con 54 L = 7,4 km/L: 26 % por debajo del habitual
      const res = await postCarga(
        d1.admin,
        carga(c1.carId, {
          odometerKm: 7 * 400,
          liters: 54,
          totalAmount: 54000,
          loadedAt: haceDias(1).toISOString(),
        }),
      ).expect(201);
      expect(cuerpoDe(res).anomaly).toBe(true);

      await esperar(() => enviados.length > 0);
      expect(enviados[0].to).toBe(d1.adminEmail);
      expect(enviados[0].subject).toContain('Consumo');

      const soloAnomalas = await http()
        .get('/fleet/fuel-loads?anomaly=true')
        .set(d1.admin)
        .expect(200);
      expect(cuerpoDe<{ total: number }>(soloAnomalas).total).toBe(1);
    });

    it('CU-322: filtra por vehículo, rango y devuelve el total de litros e importe', async () => {
      const { d1, c1 } = await escenario();
      await postCarga(
        d1.admin,
        carga(c1.carId, {
          odometerKm: 100,
          loadedAt: haceDias(10).toISOString(),
        }),
      ).expect(201);
      await postCarga(
        d1.admin,
        carga(c1.carId, {
          odometerKm: 500,
          loadedAt: haceDias(1).toISOString(),
        }),
      ).expect(201);

      const todas = cuerpoDe<{
        total: number;
        totalLiters: number;
        totalAmount: number;
        data: Cuerpo[];
      }>(await http().get('/fleet/fuel-loads').set(d1.admin).expect(200));
      expect(todas).toMatchObject({
        total: 2,
        totalLiters: 80,
        totalAmount: 80000,
      });

      const recientes = cuerpoDe<{ total: number }>(
        await http()
          .get(
            `/fleet/fuel-loads?carId=${c1.carId}&from=${diaArgentino(haceDias(3))}&to=${diaArgentino()}`,
          )
          .set(d1.admin)
          .expect(200),
      );
      expect(recientes.total).toBe(1);

      await http()
        .get('/fleet/fuel-loads?from=2026-13-45')
        .set(d1.admin)
        .expect(400);
      await http()
        .get('/fleet/fuel-loads?from=2026-10-10&to=2026-10-01')
        .set(d1.admin)
        .expect(400);
    });

    it('CU-320: modificar revalida las reglas y recalcula el kilometraje del vehículo', async () => {
      const { d1, c1 } = await escenario();
      const primera = cuerpoDe<{ fuelLoadId: string }>(
        await postCarga(
          d1.admin,
          carga(c1.carId, {
            odometerKm: 1000,
            loadedAt: haceDias(3).toISOString(),
          }),
        ).expect(201),
      );
      const segunda = cuerpoDe<{ fuelLoadId: string }>(
        await postCarga(
          d1.admin,
          carga(c1.carId, {
            odometerKm: 1500,
            loadedAt: haceDias(1).toISOString(),
          }),
        ).expect(201),
      );
      expect((await autoDe(c1.carId)).odometerKm).toBe(1500);

      // importe incoherente
      await http()
        .patch(`/fleet/fuel-loads/${segunda.fuelLoadId}`)
        .set(d1.admin)
        .send({ totalAmount: 99999 })
        .expect(400);
      // kilometraje menor que el de la anterior
      await http()
        .patch(`/fleet/fuel-loads/${segunda.fuelLoadId}`)
        .set(d1.admin)
        .send({ odometerKm: 900 })
        .expect(400);

      // corregir el kilometraje hacia abajo (error de tipeo): el vehículo lo sigue
      const ok = await http()
        .patch(`/fleet/fuel-loads/${segunda.fuelLoadId}`)
        .set(d1.admin)
        .send({ odometerKm: 1200, station: 'Shell' })
        .expect(200);
      expect(cuerpoDe(ok)).toMatchObject({
        odometerKm: 1200,
        station: 'Shell',
      });
      expect((await autoDe(c1.carId)).odometerKm).toBe(1200);

      expect(primera.fuelLoadId).toBeDefined();
    });

    it('CU-321: anular es una baja lógica que deja la carga fuera de los cálculos y recalcula el kilometraje', async () => {
      const { d1, c1 } = await escenario();
      await postCarga(
        d1.admin,
        carga(c1.carId, {
          odometerKm: 1000,
          loadedAt: haceDias(3).toISOString(),
        }),
      ).expect(201);
      const ultima = cuerpoDe<{ fuelLoadId: string }>(
        await postCarga(
          d1.admin,
          carga(c1.carId, {
            odometerKm: 1500,
            loadedAt: haceDias(1).toISOString(),
          }),
        ).expect(201),
      );

      await http()
        .delete(`/fleet/fuel-loads/${ultima.fuelLoadId}`)
        .set(d1.admin)
        .expect(200);
      expect((await autoDe(c1.carId)).odometerKm).toBe(1000);

      // se conserva: se puede abrir, con su fecha de anulación
      const vista = await http()
        .get(`/fleet/fuel-loads/${ultima.fuelLoadId}`)
        .set(d1.admin)
        .expect(200);
      expect(cuerpoDe(vista).voidedAt).not.toBeNull();
      // pero no figura en el listado vigente
      const lista = cuerpoDe<{ total: number }>(
        await http().get('/fleet/fuel-loads').set(d1.admin).expect(200),
      );
      expect(lista.total).toBe(1);

      // ya anulada: ni se anula ni se modifica
      await http()
        .delete(`/fleet/fuel-loads/${ultima.fuelLoadId}`)
        .set(d1.admin)
        .expect(409);
      await http()
        .patch(`/fleet/fuel-loads/${ultima.fuelLoadId}`)
        .set(d1.admin)
        .send({ station: 'x' })
        .expect(409);
    });

    it('CU-196: arma los tramos entre cargas de tanque lleno y calcula rendimiento y costo por km', async () => {
      const { d1, c1 } = await escenario();
      const cargas: Array<[number, number, boolean]> = [
        [1000, 50, true], // ancla
        [1300, 20, false], // parcial: suma al tramo
        [1500, 30, true], // 500 km / 50 L = 10 km/L
        [2000, 50, true], // 500 km / 50 L
      ];
      let i = 0;
      for (const [km, litros, llena] of cargas) {
        await postCarga(
          d1.admin,
          carga(c1.carId, {
            odometerKm: km,
            liters: litros,
            totalAmount: litros * 1000,
            isFullTank: llena,
            loadedAt: haceDias(10 - i).toISOString(),
          }),
        ).expect(201);
        i++;
      }

      const res = await http()
        .get(
          `/cars/${c1.carId}/fuel-efficiency?from=${diaArgentino(haceDias(30))}&to=${diaArgentino()}`,
        )
        .set(d1.admin)
        .expect(200);
      const dto = cuerpoDe<{
        tranches: Array<Cuerpo>;
        totals: Cuerpo;
        anomalies: unknown[];
      }>(res);
      expect(dto.tranches).toHaveLength(2);
      expect(dto.tranches[0]).toMatchObject({
        km: 500,
        liters: 50,
        kmPerLiter: 10,
        costPerKm: 100,
      });
      expect(dto.totals).toMatchObject({
        km: 1000,
        liters: 100,
        amount: 100000,
        kmPerLiter: 10,
        costPerKm: 100,
      });
      expect(dto.anomalies).toEqual([]);
    });

    it('CU-196: con menos de dos cargas llenas devuelve la lista vacía y totales en cero, no un error', async () => {
      const { d1, c1 } = await escenario();
      await postCarga(d1.admin, carga(c1.carId)).expect(201);
      const res = await http()
        .get(
          `/cars/${c1.carId}/fuel-efficiency?from=${diaArgentino(haceDias(30))}&to=${diaArgentino()}`,
        )
        .set(d1.admin)
        .expect(200);
      expect(cuerpoDe(res)).toMatchObject({
        tranches: [],
        totals: { km: 0, liters: 0, amount: 0 },
      });
    });

    it('CU-196: fechas invertidas o inválidas son 400', async () => {
      const { d1, c1 } = await escenario();
      await http()
        .get(`/cars/${c1.carId}/fuel-efficiency?from=2026-10-10&to=2026-10-01`)
        .set(d1.admin)
        .expect(400);
      await http()
        .get(`/cars/${c1.carId}/fuel-efficiency?from=hoy&to=2026-10-01`)
        .set(d1.admin)
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------
  // Habilitación para transportar mercancías peligrosas: CU-197
  // ---------------------------------------------------------------------
  describe('CU-197: habilitación de mercancías peligrosas', () => {
    async function planDeHabilitacion(d: Dist): Promise<MaintenancePlan> {
      return ds.getRepository(MaintenancePlan).findOneOrFail({
        where: {
          distributorId: d.distributorId,
          documentKind: MaintenanceDocumentKind.HAZMAT_VEHICLE_PERMIT,
        },
      });
    }

    it('toda distribuidora tiene el plan: de vehículo, de fecha fija, 30 días y bloqueante', async () => {
      const { d1 } = await escenario();
      const plan = await planDeHabilitacion(d1);
      expect(plan).toMatchObject({
        name: 'Habilitación para transporte de mercancías peligrosas',
        subject: 'vehicle',
        trigger: 'by_fixed_date',
        leadTimeDays: 30,
        criticality: 'blocking',
        isActive: true,
      });
    });

    it('registra la habilitación con número, autoridad, inicio y vencimiento', async () => {
      const { d1, c1 } = await escenario();
      const plan = await planDeHabilitacion(d1);
      const res = await http()
        .post('/fleet/tasks')
        .set(d1.admin)
        .send({
          planId: plan.planId,
          carId: c1.carId,
          referenceNumber: 'HAB-2026-001',
          provider: 'Secretaría de Energía',
          validFrom: sumarDias(diaArgentino(), -30),
          dueAt: sumarDias(diaArgentino(), 335),
        })
        .expect(201);
      expect(cuerpoDe(res)).toMatchObject({
        carId: c1.carId,
        referenceNumber: 'HAB-2026-001',
        provider: 'Secretaría de Energía',
        expirationStatus: 'current',
        blocks: true,
      });
    });

    it('sin vencimiento, o con el inicio posterior al vencimiento, es 400 con el campo', async () => {
      const { d1, c1 } = await escenario();
      const plan = await planDeHabilitacion(d1);
      const sinVencimiento = await http()
        .post('/fleet/tasks')
        .set(d1.admin)
        .send({ planId: plan.planId, carId: c1.carId })
        .expect(400);
      expect(JSON.stringify(sinVencimiento.body)).toContain('dueAt');

      const invertida = await http()
        .post('/fleet/tasks')
        .set(d1.admin)
        .send({
          planId: plan.planId,
          carId: c1.carId,
          validFrom: '2027-01-01',
          dueAt: '2026-12-31',
        })
        .expect(400);
      expect(JSON.stringify(invertida.body)).toContain('validFrom');
    });

    it('plan o vehículo de otra distribuidora es 404', async () => {
      const { d1, d2, c1 } = await escenario();
      const planD2 = await planDeHabilitacion(d2);
      await http()
        .post('/fleet/tasks')
        .set(d1.admin)
        .send({ planId: planD2.planId, carId: c1.carId, dueAt: '2027-01-01' })
        .expect(404);
      const planD1 = await planDeHabilitacion(d1);
      await http()
        .post('/fleet/tasks')
        .set(d2.admin)
        .send({ planId: planD1.planId, carId: c1.carId, dueAt: '2027-01-01' })
        .expect(404);
    });

    it('vencida, el vehículo queda inhabilitado y no se puede asignar a un chofer', async () => {
      const d1 = await seedDistribuidora();
      const dueno = await seedChoferConAuto(d1, { enUso: false });
      const otro = await seedChoferConAuto(d1, { enUso: false });
      const plan = await planDeHabilitacion(d1);
      await http()
        .post('/fleet/tasks')
        .set(d1.admin)
        .send({
          planId: plan.planId,
          carId: dueno.carId,
          dueAt: sumarDias(diaArgentino(), -3),
        })
        .expect(201);

      const docs = await http()
        .get(`/cars/${dueno.carId}/documents`)
        .set(d1.admin)
        .expect(200);
      expect(cuerpoDe(docs).isLocked).toBe(true);

      const asignar = await http()
        .put(`/delivery/${otro.deliveryId}/vehicle`)
        .set(d1.admin)
        .send({ carId: dueno.carId })
        .expect(400);
      expect(JSON.stringify(asignar.body)).toContain(
        'Habilitación para transporte de mercancías peligrosas',
      );
    });
  });

  // ---------------------------------------------------------------------
  // Multas: CU-198, CU-199, CU-200, CU-323, CU-324, CU-325, CU-326
  // ---------------------------------------------------------------------
  describe('multas de tránsito', () => {
    const multa = (carId: string, over: Cuerpo = {}) => ({
      carId,
      occurredAt: haceDias(1).toISOString(),
      jurisdiction: 'Municipalidad de Posadas',
      actNumber: `A-${randomUUID().slice(0, 8)}`,
      infraction: 'Exceso de velocidad',
      amount: 85000,
      voluntaryPaymentAmount: 59500,
      dueDate: sumarDias(diaArgentino(), 30),
      ...over,
    });

    const postMulta = (h: Headers, body: Cuerpo) =>
      http().post('/fleet/fines').set(h).send(body);

    it('CU-198: nace pendiente y el responsable es el chofer que tenía el vehículo en uso en la infracción', async () => {
      const { d1, c1 } = await escenario();
      const res = await postMulta(d1.admin, multa(c1.carId)).expect(201);
      expect(cuerpoDe(res)).toMatchObject({
        status: 'pending',
        employeeId: c1.employeeId,
        chargedToEmployee: false,
        amount: 85000,
        voluntaryPaymentAmount: 59500,
      });
    });

    it('CU-198: una infracción anterior a la asignación no deduce responsable; se puede indicar uno', async () => {
      const { d1, c1 } = await escenario();
      const anterior = await postMulta(
        d1.admin,
        multa(c1.carId, { occurredAt: haceDias(20).toISOString() }),
      ).expect(201);
      expect(cuerpoDe(anterior).employeeId).toBeNull();

      const indicado = await postMulta(
        d1.admin,
        multa(c1.carId, {
          occurredAt: haceDias(20).toISOString(),
          employeeId: c1.employeeId,
        }),
      ).expect(201);
      expect(cuerpoDe(indicado).employeeId).toBe(c1.employeeId);
    });

    it('CU-198: la misma jurisdicción y acta es 409 «La multa ya está registrada»; en otra jurisdicción se puede', async () => {
      const { d1, c1 } = await escenario();
      await postMulta(d1.admin, multa(c1.carId, { actNumber: 'A-1' })).expect(
        201,
      );
      const dup = await postMulta(
        d1.admin,
        multa(c1.carId, { actNumber: 'A-1' }),
      ).expect(409);
      expect(JSON.stringify(dup.body)).toContain('La multa ya está registrada');
      await postMulta(
        d1.admin,
        multa(c1.carId, { actNumber: 'A-1', jurisdiction: 'Oberá' }),
      ).expect(201);
    });

    it('CU-198: datos inválidos son 400 y el vehículo o el empleado de otra distribuidora es 404', async () => {
      const { d1, d2, c1, c2 } = await escenario();
      await postMulta(d1.admin, multa(c1.carId, { amount: 0 })).expect(400);
      await postMulta(d1.admin, multa(c1.carId, { jurisdiction: '  ' })).expect(
        400,
      );
      await postMulta(
        d1.admin,
        multa(c1.carId, { voluntaryPaymentAmount: 90000 }),
      ).expect(400);
      await postMulta(d2.admin, multa(c1.carId)).expect(404);
      await postMulta(
        d1.admin,
        multa(c1.carId, { employeeId: c2.employeeId }),
      ).expect(404);
    });

    it('CU-323: modifica los datos, la pasa a apelada y no admite el acta de otra multa', async () => {
      const { d1, c1 } = await escenario();
      await postMulta(d1.admin, multa(c1.carId, { actNumber: 'A-1' })).expect(
        201,
      );
      const b = cuerpoDe<{ fineId: string }>(
        await postMulta(d1.admin, multa(c1.carId, { actNumber: 'A-2' })).expect(
          201,
        ),
      );

      const editada = await http()
        .patch(`/fleet/fines/${b.fineId}`)
        .set(d1.admin)
        .send({ infraction: 'Luz roja', amount: 90000 })
        .expect(200);
      expect(cuerpoDe(editada)).toMatchObject({
        infraction: 'Luz roja',
        amount: 90000,
      });

      const choque = await http()
        .patch(`/fleet/fines/${b.fineId}`)
        .set(d1.admin)
        .send({ actNumber: 'A-1' })
        .expect(409);
      expect(JSON.stringify(choque.body)).toContain(
        'La multa ya está registrada',
      );

      const apelada = await http()
        .patch(`/fleet/fines/${b.fineId}`)
        .set(d1.admin)
        .send({ appeal: true })
        .expect(200);
      expect(cuerpoDe(apelada).status).toBe('appealed');

      // dato inválido
      await http()
        .patch(`/fleet/fines/${b.fineId}`)
        .set(d1.admin)
        .send({ amount: -5 })
        .expect(400);
    });

    it('CU-199: registra el pago con lo efectivamente pagado; pagada no se vuelve a pagar', async () => {
      const { d1, c1 } = await escenario();
      const m = cuerpoDe<{ fineId: string }>(
        await postMulta(d1.admin, multa(c1.carId)).expect(201),
      );
      const hoy = diaArgentino();

      await http()
        .patch(`/fleet/fines/${m.fineId}/pay`)
        .set(d1.admin)
        .send({ paidAt: sumarDias(hoy, 2), paidAmount: 59500 })
        .expect(400);
      await http()
        .patch(`/fleet/fines/${m.fineId}/pay`)
        .set(d1.admin)
        .send({ paidAt: hoy, paidAmount: 0 })
        .expect(400);

      const ok = await http()
        .patch(`/fleet/fines/${m.fineId}/pay`)
        .set(d1.admin)
        .send({ paidAt: hoy, paidAmount: 59500 })
        .expect(200);
      expect(cuerpoDe(ok)).toMatchObject({
        status: 'paid',
        paidAmount: 59500,
      });
      // el día del pago queda como el inicio de ese día en hora argentina
      expect(cuerpoDe<{ paidAt: string }>(ok).paidAt).toBe(
        `${hoy}T03:00:00.000Z`,
      );

      const otraVez = await http()
        .patch(`/fleet/fines/${m.fineId}/pay`)
        .set(d1.admin)
        .send({ paidAt: hoy, paidAmount: 59500 })
        .expect(409);
      expect(JSON.stringify(otraVez.body)).toContain(
        'La multa no admite el pago',
      );

      // pagada: no se modifica ni se anula
      await http()
        .patch(`/fleet/fines/${m.fineId}`)
        .set(d1.admin)
        .send({ infraction: 'x' })
        .expect(409);
      await http()
        .patch(`/fleet/fines/${m.fineId}/void`)
        .set(d1.admin)
        .send({ reason: 'error' })
        .expect(409);
    });

    it('CU-199: dos pagos simultáneos: uno gana y el otro es 409', async () => {
      const { d1, c1 } = await escenario();
      const m = cuerpoDe<{ fineId: string }>(
        await postMulta(d1.admin, multa(c1.carId)).expect(201),
      );
      const pagar = () =>
        http()
          .patch(`/fleet/fines/${m.fineId}/pay`)
          .set(d1.admin)
          .send({ paidAt: diaArgentino(), paidAmount: 59500 });
      const [a, b] = await Promise.all([pagar(), pagar()]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
    });

    it('CU-199: la multa de otra distribuidora es 404', async () => {
      const { d1, d2, c1 } = await escenario();
      const m = cuerpoDe<{ fineId: string }>(
        await postMulta(d1.admin, multa(c1.carId)).expect(201),
      );
      await http()
        .patch(`/fleet/fines/${m.fineId}/pay`)
        .set(d2.admin)
        .send({ paidAt: diaArgentino(), paidAmount: 1 })
        .expect(404);
      await http().get(`/fleet/fines/${m.fineId}`).set(d2.admin).expect(404);
      await http()
        .patch(`/fleet/fines/${m.fineId}/void`)
        .set(d2.admin)
        .send({ reason: 'x' })
        .expect(404);
      await http()
        .patch(`/fleet/fines/${m.fineId}`)
        .set(d2.admin)
        .send({ infraction: 'x' })
        .expect(404);
      await http()
        .patch(`/fleet/fines/${m.fineId}/charge-to-employee`)
        .set(d2.admin)
        .send({})
        .expect(404);
    });

    it('CU-324: anular exige motivo, se conserva, y una anulada no vuelve atrás', async () => {
      const { d1, c1 } = await escenario();
      const m = cuerpoDe<{ fineId: string }>(
        await postMulta(d1.admin, multa(c1.carId)).expect(201),
      );
      await http()
        .patch(`/fleet/fines/${m.fineId}/void`)
        .set(d1.admin)
        .send({})
        .expect(400);
      await http()
        .patch(`/fleet/fines/${m.fineId}/void`)
        .set(d1.admin)
        .send({ reason: '   ' })
        .expect(400);

      const ok = await http()
        .patch(`/fleet/fines/${m.fineId}/void`)
        .set(d1.admin)
        .send({ reason: 'Acta labrada a otro vehículo' })
        .expect(200);
      expect(cuerpoDe(ok)).toMatchObject({
        status: 'voided',
        voidReason: 'Acta labrada a otro vehículo',
      });
      expect(cuerpoDe(ok).voidedAt).not.toBeNull();

      await http()
        .patch(`/fleet/fines/${m.fineId}/void`)
        .set(d1.admin)
        .send({ reason: 'otra vez' })
        .expect(409);
      await http()
        .patch(`/fleet/fines/${m.fineId}/pay`)
        .set(d1.admin)
        .send({ paidAt: diaArgentino(), paidAmount: 1000 })
        .expect(409);
      // se conserva
      await http().get(`/fleet/fines/${m.fineId}`).set(d1.admin).expect(200);
    });

    it('CU-200: imputa al chofer (también una pagada); una anulada no; sin responsable pide uno', async () => {
      const { d1, c1, c2 } = await escenario();
      const pagada = cuerpoDe<{ fineId: string }>(
        await postMulta(d1.admin, multa(c1.carId)).expect(201),
      );
      await http()
        .patch(`/fleet/fines/${pagada.fineId}/pay`)
        .set(d1.admin)
        .send({ paidAt: diaArgentino(), paidAmount: 59500 })
        .expect(200);
      const imputada = await http()
        .patch(`/fleet/fines/${pagada.fineId}/charge-to-employee`)
        .set(d1.admin)
        .send({})
        .expect(200);
      expect(cuerpoDe(imputada)).toMatchObject({
        chargedToEmployee: true,
        employeeId: c1.employeeId,
        status: 'paid',
      });

      const anulada = cuerpoDe<{ fineId: string }>(
        await postMulta(d1.admin, multa(c1.carId)).expect(201),
      );
      await http()
        .patch(`/fleet/fines/${anulada.fineId}/void`)
        .set(d1.admin)
        .send({ reason: 'error' })
        .expect(200);
      const rechazo = await http()
        .patch(`/fleet/fines/${anulada.fineId}/charge-to-employee`)
        .set(d1.admin)
        .send({})
        .expect(409);
      expect(JSON.stringify(rechazo.body)).toContain(
        'La multa anulada no se puede imputar',
      );

      const sinResponsable = cuerpoDe<{ fineId: string }>(
        await postMulta(
          d1.admin,
          multa(c1.carId, { occurredAt: haceDias(20).toISOString() }),
        ).expect(201),
      );
      await http()
        .patch(`/fleet/fines/${sinResponsable.fineId}/charge-to-employee`)
        .set(d1.admin)
        .send({})
        .expect(400);
      // un empleado de otra distribuidora no existe para esta
      await http()
        .patch(`/fleet/fines/${sinResponsable.fineId}/charge-to-employee`)
        .set(d1.admin)
        .send({ employeeId: c2.employeeId })
        .expect(404);
      const indicado = await http()
        .patch(`/fleet/fines/${sinResponsable.fineId}/charge-to-employee`)
        .set(d1.admin)
        .send({ employeeId: c1.employeeId })
        .expect(200);
      expect(cuerpoDe(indicado).employeeId).toBe(c1.employeeId);
    });

    it('CU-325: filtra por vehículo, estado y fechas, con el total', async () => {
      const { d1, c1 } = await escenario();
      const a = cuerpoDe<{ fineId: string }>(
        await postMulta(d1.admin, multa(c1.carId)).expect(201),
      );
      await postMulta(
        d1.admin,
        multa(c1.carId, { occurredAt: haceDias(40).toISOString() }),
      ).expect(201);
      await http()
        .patch(`/fleet/fines/${a.fineId}/void`)
        .set(d1.admin)
        .send({ reason: 'x' })
        .expect(200);

      const todas = cuerpoDe<{ total: number }>(
        await http().get('/fleet/fines').set(d1.admin).expect(200),
      );
      expect(todas.total).toBe(2);
      const pendientes = cuerpoDe<{ total: number }>(
        await http()
          .get(`/fleet/fines?carId=${c1.carId}&status=pending`)
          .set(d1.admin)
          .expect(200),
      );
      expect(pendientes.total).toBe(1);
      const recientes = cuerpoDe<{ total: number }>(
        await http()
          .get(`/fleet/fines?from=${diaArgentino(haceDias(5))}`)
          .set(d1.admin)
          .expect(200),
      );
      expect(recientes.total).toBe(1);
      await http().get('/fleet/fines?status=otra').set(d1.admin).expect(400);
    });

    it('CU-326: avisa por correo las pendientes que vencen en 7 días o menos (o vencidas) y marca para no repetir', async () => {
      const { d1, d2, c1, c2 } = await escenario();
      const hoy = diaArgentino();
      const crear = async (h: Headers, carId: string, dueDate: string | null) =>
        cuerpoDe<{ fineId: string }>(
          await postMulta(h, multa(carId, { dueDate })).expect(201),
        );
      const proxima = await crear(d1.admin, c1.carId, sumarDias(hoy, 5));
      const vencida = await crear(d1.admin, c1.carId, sumarDias(hoy, -2));
      const lejana = await crear(d1.admin, c1.carId, sumarDias(hoy, 20));
      const pagada = await crear(d1.admin, c1.carId, sumarDias(hoy, 3));
      await http()
        .patch(`/fleet/fines/${pagada.fineId}/pay`)
        .set(d1.admin)
        .send({ paidAt: hoy, paidAmount: 100 })
        .expect(200);
      const anulada = await crear(d1.admin, c1.carId, sumarDias(hoy, 3));
      await http()
        .patch(`/fleet/fines/${anulada.fineId}/void`)
        .set(d1.admin)
        .send({ reason: 'x' })
        .expect(200);
      const deOtra = await crear(d2.admin, c2.carId, sumarDias(hoy, 1));

      const cron = env.app.get(FineDueAlertsCron);
      await cron.avisarMultasPorVencer();

      const alertadas = async () =>
        (await ds.getRepository(TrafficFine).find({ where: {} }))
          .filter((m) => m.alertedAt !== null)
          .map((m) => m.fineId)
          .sort();
      expect(await alertadas()).toEqual(
        [proxima.fineId, vencida.fineId, deOtra.fineId].sort(),
      );
      expect(lejana.fineId).toBeDefined();
      expect(enviados.map((m) => m.to).sort()).toEqual(
        [d1.adminEmail, d2.adminEmail].sort(),
      );
      const aviso1 = enviados.find((m) => m.to === d1.adminEmail);
      expect(aviso1?.html).toContain('VENCIDA');

      // la corrida siguiente no repite
      enviados = [];
      await cron.avisarMultasPorVencer();
      expect(enviados).toEqual([]);
    });

    it('CU-326: si el envío falla no marca y se reintenta en la corrida siguiente', async () => {
      const { d1, c1 } = await escenario();
      const m = cuerpoDe<{ fineId: string }>(
        await postMulta(
          d1.admin,
          multa(c1.carId, { dueDate: sumarDias(diaArgentino(), 2) }),
        ).expect(201),
      );
      const cron = env.app.get(FineDueAlertsCron);

      envioFalla = true;
      await cron.avisarMultasPorVencer();
      const sinMarcar = await ds
        .getRepository(TrafficFine)
        .findOneByOrFail({ fineId: m.fineId });
      expect(sinMarcar.alertedAt).toBeNull();

      envioFalla = false;
      await cron.avisarMultasPorVencer();
      expect(enviados).toHaveLength(1);
      const marcada = await ds
        .getRepository(TrafficFine)
        .findOneByOrFail({ fineId: m.fineId });
      expect(marcada.alertedAt).not.toBeNull();
    });

    it('CU-326: una fecha de vencimiento nueva vuelve a entrar en el aviso', async () => {
      const { d1, c1 } = await escenario();
      const m = cuerpoDe<{ fineId: string }>(
        await postMulta(
          d1.admin,
          multa(c1.carId, { dueDate: sumarDias(diaArgentino(), 2) }),
        ).expect(201),
      );
      const cron = env.app.get(FineDueAlertsCron);
      await cron.avisarMultasPorVencer();
      await http()
        .patch(`/fleet/fines/${m.fineId}`)
        .set(d1.admin)
        .send({ dueDate: sumarDias(diaArgentino(), 3) })
        .expect(200);
      enviados = [];
      await cron.avisarMultasPorVencer();
      expect(enviados).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  // Siniestros y reactivación: CU-201, CU-327, CU-328, CU-202, CU-247
  // ---------------------------------------------------------------------
  describe('siniestros', () => {
    const siniestro = (carId: string, over: Cuerpo = {}) => ({
      carId,
      occurredAt: haceDias(1).toISOString(),
      description: 'Choque trasero en Bolívar y Colón',
      location: '-27.3671,-55.8961',
      address: 'Bolívar y Colón',
      ...over,
    });
    const postSiniestro = (h: Headers, body: Cuerpo) =>
      http().post('/fleet/accidents').set(h).send(body);

    it('CU-201: nace denunciado, con el punto en el mapa y el conductor deducido', async () => {
      const { d1, c1 } = await escenario();
      const res = await postSiniestro(d1.admin, siniestro(c1.carId)).expect(
        201,
      );
      expect(cuerpoDe(res)).toMatchObject({
        status: 'reported',
        location: '-27.3671,-55.8961',
        employeeId: c1.employeeId,
        vehicleUnusable: false,
        hazmatRelease: false,
      });
      expect((await autoDe(c1.carId)).fleetStatus).toBe(FleetStatus.ACTIVE);
    });

    it('CU-201: inutilizable deja el vehículo fuera de servicio y libera a su chofer', async () => {
      const { d1, c1 } = await escenario();
      await postSiniestro(
        d1.admin,
        siniestro(c1.carId, { vehicleUnusable: true }),
      ).expect(201);

      expect((await autoDe(c1.carId)).fleetStatus).toBe(FleetStatus.GROUNDED);
      const abiertas = await ds
        .getRepository(VehicleAssignment)
        .createQueryBuilder('a')
        .where('a.car_id = :id AND a.released_at IS NULL', { id: c1.carId })
        .getCount();
      expect(abiertas).toBe(0);

      // el chofer quedó sin vehículo: no puede cargar combustible
      await http()
        .post('/fleet/fuel-loads/mine')
        .set(c1.headers)
        .send({
          liters: 10,
          unitPrice: 1000,
          totalAmount: 10000,
          odometerKm: 10,
          paymentMethod: 'card',
        })
        .expect(404);

      // y el vehículo fuera de servicio no se asigna
      const asignar = await http()
        .put(`/delivery/${c1.deliveryId}/vehicle`)
        .set(d1.admin)
        .send({ carId: c1.carId })
        .expect(409);
      expect(JSON.stringify(asignar.body)).toContain('fuera de servicio');
    });

    it('CU-201: inutilizable con un pedido en curso o una carga de camión abierta es 409 y no registra nada', async () => {
      const { d1, c1 } = await escenario();
      const abiertas = async () =>
        ds
          .getRepository(VehicleAssignment)
          .createQueryBuilder('a')
          .where('a.car_id = :id AND a.released_at IS NULL', { id: c1.carId })
          .getCount();

      // carga de camión abierta (sin armar el depósito: sólo importa que exista)
      await ds.transaction(async (m) => {
        await m.query('SET LOCAL session_replication_role = replica');
        await m.query(
          `INSERT INTO "truck_load" ("distributor_id", "number", "car_id", "delivery_id", "origin_location_id", "business_date", "status", "opened_by_user_id")
           VALUES ($1, 1, $2, $3, $4, CURRENT_DATE, 'loading', $5)`,
          [
            d1.distributorId,
            c1.carId,
            c1.deliveryId,
            randomUUID(),
            randomUUID(),
          ],
        );
      });
      const res = await postSiniestro(
        d1.admin,
        siniestro(c1.carId, { vehicleUnusable: true }),
      ).expect(409);
      expect(JSON.stringify(res.body)).toContain('fuera de servicio');
      expect((await autoDe(c1.carId)).fleetStatus).toBe(FleetStatus.ACTIVE);
      expect(await abiertas()).toBe(1);
      const lista = cuerpoDe<{ total: number }>(
        await http().get('/fleet/accidents').set(d1.admin).expect(200),
      );
      expect(lista.total).toBe(0);
    });

    it('CU-201: un derrame de gas avisa de inmediato a los administradores', async () => {
      const { d1, c1 } = await escenario();
      await postSiniestro(
        d1.admin,
        siniestro(c1.carId, { hazmatRelease: true }),
      ).expect(201);
      await esperar(() => enviados.length > 0);
      expect(enviados[0].to).toBe(d1.adminEmail);
      expect(enviados[0].subject).toContain('derrame');
    });

    it('CU-201: el chofer reporta el de su vehículo en uso; sin vehículo es 404', async () => {
      const { c1 } = await escenario();
      const res = await http()
        .post('/fleet/accidents/mine')
        .set(c1.headers)
        .send({
          occurredAt: haceDias(0).toISOString(),
          description: 'Rozón al estacionar',
          vehicleUnusable: false,
        })
        .expect(201);
      expect(cuerpoDe(res)).toMatchObject({
        carId: c1.carId,
        employeeId: c1.employeeId,
      });

      const d = await seedDistribuidora();
      const sinAuto = await seedChoferConAuto(d, { enUso: false });
      const sin = await http()
        .post('/fleet/accidents/mine')
        .set(sinAuto.headers)
        .send({ occurredAt: haceDias(0).toISOString(), description: 'x' })
        .expect(404);
      expect(JSON.stringify(sin.body)).toContain('No tenés un vehículo en uso');
    });

    it('CU-201: sin descripción, con un punto inválido o futuro es 400; vehículo de otra distribuidora es 404', async () => {
      const { d1, d2, c1 } = await escenario();
      await postSiniestro(
        d1.admin,
        siniestro(c1.carId, { description: ' ' }),
      ).expect(400);
      await postSiniestro(
        d1.admin,
        siniestro(c1.carId, { location: '95,200' }),
      ).expect(400);
      await postSiniestro(
        d1.admin,
        siniestro(c1.carId, { location: 'no' }),
      ).expect(400);
      await postSiniestro(
        d1.admin,
        siniestro(c1.carId, {
          occurredAt: new Date(Date.now() + 3 * DIA_EN_MS).toISOString(),
        }),
      ).expect(400);
      await postSiniestro(d2.admin, siniestro(c1.carId)).expect(404);
    });

    it('CU-327: avanza el ciclo de a un estado; no saltea, no retrocede y un cerrado no se modifica', async () => {
      const { d1, c1 } = await escenario();
      const s = cuerpoDe<{ accidentId: string }>(
        await postSiniestro(d1.admin, siniestro(c1.carId)).expect(201),
      );
      const patch = (body: Cuerpo) =>
        http()
          .patch(`/fleet/accidents/${s.accidentId}`)
          .set(d1.admin)
          .send(body);

      await patch({ status: 'repairing' }).expect(409); // saltea
      const enRevision = await patch({
        status: 'under_review',
        policeReportNumber: 'D-123',
        injuries: true,
      }).expect(200);
      expect(cuerpoDe(enRevision)).toMatchObject({
        status: 'under_review',
        policeReportNumber: 'D-123',
        injuries: true,
      });
      await patch({ status: 'reported' }).expect(409); // retrocede
      await patch({ status: 'closed' }).expect(409); // se cierra con PATCH …/close
      await patch({ status: 'repairing' }).expect(200);
      await patch({ description: '' }).expect(400);
      // no se puede cambiar si quedó inutilizable por acá
      await patch({ vehicleUnusable: true }).expect(400);

      await http()
        .patch(`/fleet/accidents/${s.accidentId}/close`)
        .set(d1.admin)
        .send({
          repairCost: 1000,
          insurerReimbursement: 0,
          deductibleAmount: 0,
        })
        .expect(200);
      await patch({ description: 'tarde' }).expect(409);

      // otra distribuidora
      await http()
        .patch(`/fleet/accidents/${s.accidentId}`)
        .set((await seedDistribuidora()).admin)
        .send({ description: 'x' })
        .expect(404);
    });

    it('CU-202: cerrar asienta los importes, no reactiva el vehículo y no se cierra dos veces', async () => {
      const { d1, c1 } = await escenario();
      const s = cuerpoDe<{ accidentId: string }>(
        await postSiniestro(
          d1.admin,
          siniestro(c1.carId, { vehicleUnusable: true }),
        ).expect(201),
      );
      const cerrar = (body: Cuerpo) =>
        http()
          .patch(`/fleet/accidents/${s.accidentId}/close`)
          .set(d1.admin)
          .send(body);

      await cerrar({
        repairCost: -1,
        insurerReimbursement: 0,
        deductibleAmount: 0,
      }).expect(400);
      await cerrar({ repairCost: 1000 }).expect(400);

      const ok = await cerrar({
        repairCost: 350000,
        insurerReimbursement: 250000,
        deductibleAmount: 50000,
      }).expect(200);
      expect(cuerpoDe(ok)).toMatchObject({
        status: 'closed',
        repairCost: 350000,
        insurerReimbursement: 250000,
        deductibleAmount: 50000,
        netCost: 100000,
      });
      expect(cuerpoDe(ok).closedAt).not.toBeNull();
      // cerrar NO reactiva el vehículo
      expect((await autoDe(c1.carId)).fleetStatus).toBe(FleetStatus.GROUNDED);

      const otraVez = await cerrar({
        repairCost: 1,
        insurerReimbursement: 0,
        deductibleAmount: 0,
      }).expect(409);
      expect(JSON.stringify(otraVez.body)).toContain(
        'El siniestro ya está cerrado',
      );
    });

    it('CU-328: filtra por vehículo, estado y fechas y abre uno puntual; otra distribuidora no lo ve', async () => {
      const { d1, d2, c1 } = await escenario();
      const s = cuerpoDe<{ accidentId: string }>(
        await postSiniestro(d1.admin, siniestro(c1.carId)).expect(201),
      );
      await postSiniestro(
        d1.admin,
        siniestro(c1.carId, { occurredAt: haceDias(60).toISOString() }),
      ).expect(201);

      const todos = cuerpoDe<{ total: number }>(
        await http().get('/fleet/accidents').set(d1.admin).expect(200),
      );
      expect(todos.total).toBe(2);
      const recientes = cuerpoDe<{ total: number }>(
        await http()
          .get(
            `/fleet/accidents?carId=${c1.carId}&status=reported&from=${diaArgentino(haceDias(5))}`,
          )
          .set(d1.admin)
          .expect(200),
      );
      expect(recientes.total).toBe(1);
      await http()
        .get(`/fleet/accidents/${s.accidentId}`)
        .set(d1.admin)
        .expect(200);
      await http()
        .get(`/fleet/accidents/${s.accidentId}`)
        .set(d2.admin)
        .expect(404);
      const ajena = cuerpoDe<{ total: number }>(
        await http().get('/fleet/accidents').set(d2.admin).expect(200),
      );
      expect(ajena.total).toBe(0);
      await http().get('/fleet/accidents?status=xx').set(d1.admin).expect(400);
    });

    describe('CU-247: reactivar un vehículo', () => {
      async function fueraDeServicio(d: Dist, c: Chofer) {
        await postSiniestro(
          d.admin,
          siniestro(c.carId, { vehicleUnusable: true }),
        ).expect(201);
      }

      it('lo pasa de fuera de servicio a activo si la documentación está en regla; no lo asigna a nadie', async () => {
        const { d1, c1 } = await escenario();
        await fueraDeServicio(d1, c1);
        const res = await http()
          .post(`/car/${c1.carId}/reactivate`)
          .set(d1.admin)
          .expect(201);
        expect(cuerpoDe(res)).toMatchObject({
          car_id: c1.carId,
          fleet_status: 'active',
        });
        expect((await autoDe(c1.carId)).fleetStatus).toBe(FleetStatus.ACTIVE);
        const abiertas = await ds
          .getRepository(VehicleAssignment)
          .createQueryBuilder('a')
          .where('a.car_id = :id AND a.released_at IS NULL', { id: c1.carId })
          .getCount();
        expect(abiertas).toBe(0);
        // vuelve a poder asignarse
        await http()
          .put(`/delivery/${c1.deliveryId}/vehicle`)
          .set(d1.admin)
          .send({ carId: c1.carId })
          .expect(200);
      });

      it('si el vehículo no está fuera de servicio es 409 «El vehículo no está fuera de servicio»', async () => {
        const { d1, c1 } = await escenario();
        const res = await http()
          .post(`/car/${c1.carId}/reactivate`)
          .set(d1.admin)
          .expect(409);
        expect(JSON.stringify(res.body)).toContain(
          'El vehículo no está fuera de servicio',
        );
      });

      it('con la habilitación (o el seguro) vencida rechaza e indica cuál', async () => {
        const { d1, c1 } = await escenario();
        await fueraDeServicio(d1, c1);
        const plan = await ds.getRepository(MaintenancePlan).findOneOrFail({
          where: {
            distributorId: d1.distributorId,
            documentKind: MaintenanceDocumentKind.HAZMAT_VEHICLE_PERMIT,
          },
        });
        await http()
          .post('/fleet/tasks')
          .set(d1.admin)
          .send({
            planId: plan.planId,
            carId: c1.carId,
            dueAt: sumarDias(diaArgentino(), -1),
          })
          .expect(201);
        const res = await http()
          .post(`/car/${c1.carId}/reactivate`)
          .set(d1.admin)
          .expect(400);
        expect(JSON.stringify(res.body)).toContain(
          'Habilitación para transporte de mercancías peligrosas',
        );
        expect((await autoDe(c1.carId)).fleetStatus).toBe(FleetStatus.GROUNDED);
      });

      it('el vehículo de otra distribuidora es 404', async () => {
        const { d1, d2, c1 } = await escenario();
        await fueraDeServicio(d1, c1);
        await http()
          .post(`/car/${c1.carId}/reactivate`)
          .set(d2.admin)
          .expect(404);
        expect((await autoDe(c1.carId)).fleetStatus).toBe(FleetStatus.GROUNDED);
      });
    });
  });

  // ---------------------------------------------------------------------
  // Costos: CU-203, CU-204
  // ---------------------------------------------------------------------
  describe('costo total por vehículo y tablero de la flota', () => {
    async function planPor(
      d: Dist,
      kind: MaintenanceDocumentKind | null,
      name?: string,
    ) {
      return ds.getRepository(MaintenancePlan).findOneOrFail({
        where: kind
          ? { distributorId: d.distributorId, documentKind: kind }
          : { distributorId: d.distributorId, name },
      });
    }

    /** Un vehículo con los cinco rubros dentro de [hoy-9, hoy]. */
    async function armarCostos(d: Dist, c: Chofer) {
      const hoy = diaArgentino();
      const desde = sumarDias(hoy, -9);

      // mantenimiento: 100000 (tarea de service hecha hoy)
      const service = await planPor(d, null, 'Service / cambio de aceite');
      const tarea = cuerpoDe<{ taskId: string }>(
        await http()
          .post('/fleet/tasks')
          .set(d.admin)
          .send({ planId: service.planId, carId: c.carId, dueKm: 5000 })
          .expect(201),
      );
      await http()
        .patch(`/fleet/tasks/${tarea.taskId}/close`)
        .set(d.admin)
        .send({ performedAt: new Date().toISOString(), cost: 100000 })
        .expect(200);

      // seguro: 100 días de vigencia que arrancan en `desde`, prima 100000;
      // en el rango caen 10 días: 10000
      const seguro = await planPor(d, MaintenanceDocumentKind.INSURANCE);
      await http()
        .post('/fleet/tasks')
        .set(d.admin)
        .send({
          planId: seguro.planId,
          carId: c.carId,
          validFrom: desde,
          dueAt: sumarDias(desde, 99),
          cost: 100000,
          referenceNumber: 'POL-1',
        })
        .expect(201);

      // combustible: 2 × 40000, kilometraje 1000 -> 1500 (500 km)
      for (const [km, dias] of [
        [1000, 5],
        [1500, 1],
      ] as const) {
        await http()
          .post('/fleet/fuel-loads')
          .set(d.admin)
          .send({
            carId: c.carId,
            liters: 40,
            unitPrice: 1000,
            totalAmount: 40000,
            odometerKm: km,
            paymentMethod: 'card',
            loadedAt: haceDias(dias).toISOString(),
          })
          .expect(201);
      }

      // multa pagada y sin imputar: 59500. Otra pagada e imputada: no cuenta.
      for (const imputar of [false, true]) {
        const m = cuerpoDe<{ fineId: string }>(
          await http()
            .post('/fleet/fines')
            .set(d.admin)
            .send({
              carId: c.carId,
              occurredAt: haceDias(2).toISOString(),
              jurisdiction: 'Posadas',
              actNumber: `A-${randomUUID().slice(0, 6)}`,
              infraction: 'x',
              amount: 85000,
            })
            .expect(201),
        );
        await http()
          .patch(`/fleet/fines/${m.fineId}/pay`)
          .set(d.admin)
          .send({ paidAt: hoy, paidAmount: 59500 })
          .expect(200);
        if (imputar) {
          await http()
            .patch(`/fleet/fines/${m.fineId}/charge-to-employee`)
            .set(d.admin)
            .send({})
            .expect(200);
        }
      }

      // siniestro cerrado: 350000 - 250000 = 100000. Otro sin cerrar: no cuenta.
      const s = cuerpoDe<{ accidentId: string }>(
        await http()
          .post('/fleet/accidents')
          .set(d.admin)
          .send({
            carId: c.carId,
            occurredAt: haceDias(3).toISOString(),
            description: 'Choque',
          })
          .expect(201),
      );
      await http()
        .patch(`/fleet/accidents/${s.accidentId}/close`)
        .set(d.admin)
        .send({
          repairCost: 350000,
          insurerReimbursement: 250000,
          deductibleAmount: 50000,
        })
        .expect(200);
      await http()
        .post('/fleet/accidents')
        .set(d.admin)
        .send({
          carId: c.carId,
          occurredAt: haceDias(3).toISOString(),
          description: 'Sin cerrar',
        })
        .expect(201);

      return { desde, hoy };
    }

    it('CU-203: suma los cinco rubros, calcula km y costo por km y arma la evolución mensual', async () => {
      const { d1, c1 } = await escenario();
      const { desde, hoy } = await armarCostos(d1, c1);

      const res = await http()
        .get(`/cars/${c1.carId}/costs?from=${desde}&to=${hoy}`)
        .set(d1.admin)
        .expect(200);
      const dto = cuerpoDe<{
        monthly: Array<{ month: string; total: number }>;
      }>(res);
      expect(dto).toMatchObject({
        carId: c1.carId,
        maintenance: 100000,
        insurance: 10000,
        fuel: 80000,
        fines: 59500,
        accidents: 100000,
        total: 349500,
        km: 500,
        kmSource: 'odometer',
        costPerKm: 699,
        insuranceEstimated: false,
      });
      expect(dto.monthly.length).toBeGreaterThanOrEqual(1);
      expect(dto.monthly.reduce((s, m) => s + m.total, 0)).toBeCloseTo(
        349500,
        1,
      );
    });

    it('CU-203: una carga anulada deja de contar en el costo', async () => {
      const { d1, c1 } = await escenario();
      const { desde, hoy } = await armarCostos(d1, c1);
      const lista = cuerpoDe<{ data: Array<{ fuelLoadId: string }> }>(
        await http().get('/fleet/fuel-loads').set(d1.admin).expect(200),
      );
      await http()
        .delete(`/fleet/fuel-loads/${lista.data[0].fuelLoadId}`)
        .set(d1.admin)
        .expect(200);
      const res = await http()
        .get(`/cars/${c1.carId}/costs?from=${desde}&to=${hoy}`)
        .set(d1.admin)
        .expect(200);
      expect(cuerpoDe(res).fuel).toBe(40000);
    });

    it('CU-203: la póliza sin inicio de vigencia se prorratea con un año hacia atrás y se indica como estimada', async () => {
      const { d1, c1 } = await escenario();
      const seguro = await ds.getRepository(MaintenancePlan).findOneOrFail({
        where: {
          distributorId: d1.distributorId,
          documentKind: MaintenanceDocumentKind.INSURANCE,
        },
      });
      const hoy = diaArgentino();
      await http()
        .post('/fleet/tasks')
        .set(d1.admin)
        .send({
          planId: seguro.planId,
          carId: c1.carId,
          dueAt: sumarDias(hoy, 100),
          cost: 365000,
        })
        .expect(201);
      const res = await http()
        .get(`/cars/${c1.carId}/costs?from=${sumarDias(hoy, -9)}&to=${hoy}`)
        .set(d1.admin)
        .expect(200);
      expect(cuerpoDe(res).insuranceEstimated).toBe(true);
      expect(cuerpoDe<{ insurance: number }>(res).insurance).toBeGreaterThan(0);
    });

    it('CU-203: vehículo de otra distribuidora es 404; fechas inválidas, invertidas o de más de cinco años son 400', async () => {
      const { d1, d2, c1 } = await escenario();
      await http()
        .get(`/cars/${c1.carId}/costs?from=2026-01-01&to=2026-02-01`)
        .set(d2.admin)
        .expect(404);
      await http()
        .get(`/cars/${c1.carId}/costs?from=2026-02-01&to=2026-01-01`)
        .set(d1.admin)
        .expect(400);
      await http()
        .get(`/cars/${c1.carId}/costs?from=2026-02-31&to=2026-03-01`)
        .set(d1.admin)
        .expect(400);
      await http()
        .get(`/cars/${c1.carId}/costs?from=2010-01-01&to=2026-03-01`)
        .set(d1.admin)
        .expect(400);
      await http().get(`/cars/${c1.carId}/costs`).set(d1.admin).expect(400);
    });

    it('CU-204: un renglón por vehículo, de mayor a menor costo por km; sin km al final', async () => {
      const d1 = await seedDistribuidora();
      const d2 = await seedDistribuidora();
      const caro = await seedChoferConAuto(d1);
      const barato = await seedChoferConAuto(d1);
      const sinKm = await seedChoferConAuto(d1);
      const ajeno = await seedChoferConAuto(d2);
      const hoy = diaArgentino();
      const desde = sumarDias(hoy, -9);

      const cargar = async (c: Chofer, monto: number) => {
        for (const [km, dias] of [
          [1000, 5],
          [1500, 1],
        ] as const) {
          await http()
            .post('/fleet/fuel-loads')
            .set(d1.admin)
            .send({
              carId: c.carId,
              liters: 40,
              unitPrice: monto / 40,
              totalAmount: monto,
              odometerKm: km,
              paymentMethod: 'card',
              loadedAt: haceDias(dias).toISOString(),
            })
            .expect(201);
        }
      };
      await cargar(caro, 80000); // 160000 / 500 km = 320 $/km
      await cargar(barato, 20000); // 40000 / 500 km = 80 $/km
      // el sin km: un gasto sin kilómetros
      const mult = cuerpoDe<{ fineId: string }>(
        await http()
          .post('/fleet/fines')
          .set(d1.admin)
          .send({
            carId: sinKm.carId,
            occurredAt: haceDias(2).toISOString(),
            jurisdiction: 'Posadas',
            actNumber: 'Z-1',
            infraction: 'x',
            amount: 500000,
          })
          .expect(201),
      );
      await http()
        .patch(`/fleet/fines/${mult.fineId}/pay`)
        .set(d1.admin)
        .send({ paidAt: hoy, paidAmount: 500000 })
        .expect(200);

      const res = await http()
        .get(`/fleet/costs?from=${desde}&to=${hoy}`)
        .set(d1.admin)
        .expect(200);
      const filas = cuerpoDe<Array<Cuerpo>>(res);
      expect(filas.map((f) => f.carId)).toEqual([
        caro.carId,
        barato.carId,
        sinKm.carId,
      ]);
      expect(filas[0]).toMatchObject({
        costPerKm: 320,
        km: 500,
        total: 160000,
      });
      expect(filas[2]).toMatchObject({
        costPerKm: null,
        km: 0,
        total: 500000,
        kmSource: 'none',
      });
      // el de otra distribuidora no figura, y el rango inválido es 400
      expect(filas.some((f) => f.carId === ajeno.carId)).toBe(false);
      await http()
        .get('/fleet/costs?from=2026-10-10&to=2026-10-01')
        .set(d1.admin)
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------
  // Neumáticos: CU-205, CU-206
  // ---------------------------------------------------------------------
  describe('neumáticos', () => {
    const neumatico = (over: Cuerpo = {}) => ({
      serialNumber: `DOT-${randomUUID().slice(0, 8)}`,
      brand: 'Pirelli',
      size: '215/75 R17.5',
      cost: 320000,
      ...over,
    });
    const postNeumatico = (h: Headers, body: Cuerpo) =>
      http().post('/fleet/tires').set(h).send(body);
    const evento = (h: Headers, id: string, body: Cuerpo) =>
      http().post(`/fleet/tires/${id}/events`).set(h).send(body);

    it('CU-205: nace en depósito, sin vehículo ni posición; el número de serie es único por distribuidora', async () => {
      const { d1, d2 } = await escenario();
      const res = await postNeumatico(
        d1.admin,
        neumatico({ serialNumber: 'S-1' }),
      ).expect(201);
      expect(cuerpoDe(res)).toMatchObject({
        status: 'in_stock',
        carId: null,
        position: null,
        kmTraveled: 0,
      });
      const dup = await postNeumatico(
        d1.admin,
        neumatico({ serialNumber: 'S-1' }),
      ).expect(409);
      expect(JSON.stringify(dup.body)).toContain(
        'El neumático ya está registrado',
      );
      // otra distribuidora puede tener la misma serie
      await postNeumatico(d2.admin, neumatico({ serialNumber: 'S-1' })).expect(
        201,
      );
      // costo negativo / faltantes: 400
      await postNeumatico(d1.admin, neumatico({ cost: -1 })).expect(400);
      await postNeumatico(d1.admin, neumatico({ brand: '' })).expect(400);
    });

    it('CU-206: monta, rota, desmonta y da de baja; acumula los km y deja el historial', async () => {
      const { d1, c1 } = await escenario();
      const t = cuerpoDe<{ tireId: string }>(
        await postNeumatico(d1.admin, neumatico()).expect(201),
      );

      const montaje = await evento(d1.admin, t.tireId, {
        type: 'mount',
        odometerKm: 10000,
        carId: c1.carId,
        position: 'di',
      }).expect(201);
      expect(cuerpoDe<{ tire: Cuerpo }>(montaje).tire).toMatchObject({
        status: 'mounted',
        carId: c1.carId,
        position: 'DI',
        mountedOdometerKm: 10000,
      });

      const rotacion = await evento(d1.admin, t.tireId, {
        type: 'rotate',
        odometerKm: 15000,
        position: 'TD',
      }).expect(201);
      expect(cuerpoDe<{ tire: Cuerpo }>(rotacion).tire).toMatchObject({
        position: 'TD',
        kmTraveled: 5000,
        mountedOdometerKm: 15000,
      });

      const desmontaje = await evento(d1.admin, t.tireId, {
        type: 'unmount',
        odometerKm: 18000,
      }).expect(201);
      expect(cuerpoDe<{ tire: Cuerpo }>(desmontaje).tire).toMatchObject({
        status: 'in_stock',
        carId: null,
        position: null,
        kmTraveled: 8000,
      });

      await evento(d1.admin, t.tireId, {
        type: 'retread',
        odometerKm: 18000,
      }).expect(201);
      await evento(d1.admin, t.tireId, {
        type: 'retire',
        odometerKm: 18000,
      }).expect(201);

      const vista = cuerpoDe<{
        status: string;
        retreadCount: number;
        events: Array<{ type: string }>;
      }>(
        await http().get(`/fleet/tires/${t.tireId}`).set(d1.admin).expect(200),
      );
      expect(vista).toMatchObject({ status: 'retired', retreadCount: 1 });
      expect(vista.events.map((e) => e.type).sort()).toEqual(
        ['mount', 'retire', 'retread', 'rotate', 'unmount'].sort(),
      );
    });

    it('CU-206: un movimiento que no corresponde al estado es 409 «Movimiento inválido para el estado del neumático»', async () => {
      const { d1, c1 } = await escenario();
      const t = cuerpoDe<{ tireId: string }>(
        await postNeumatico(d1.admin, neumatico()).expect(201),
      );
      const montar = {
        type: 'mount',
        odometerKm: 100,
        carId: c1.carId,
        position: 'DI',
      };
      await evento(d1.admin, t.tireId, montar).expect(201);
      const res = await evento(d1.admin, t.tireId, montar).expect(409);
      expect(JSON.stringify(res.body)).toContain(
        'Movimiento inválido para el estado del neumático',
      );
      await evento(d1.admin, t.tireId, {
        type: 'retread',
        odometerKm: 100,
      }).expect(409);

      const deposito = cuerpoDe<{ tireId: string }>(
        await postNeumatico(d1.admin, neumatico()).expect(201),
      );
      await evento(d1.admin, deposito.tireId, {
        type: 'unmount',
        odometerKm: 100,
      }).expect(409);
      await evento(d1.admin, deposito.tireId, {
        type: 'rotate',
        odometerKm: 100,
        position: 'TD',
      }).expect(409);

      // la baja es definitiva
      await evento(d1.admin, deposito.tireId, {
        type: 'retire',
        odometerKm: 100,
      }).expect(201);
      await evento(d1.admin, deposito.tireId, {
        type: 'mount',
        odometerKm: 100,
        carId: c1.carId,
        position: 'TI',
      }).expect(409);
    });

    it('CU-206: falta de vehículo, posición o kilometraje es 400; la posición ocupada es 409; el kilometraje no va hacia atrás', async () => {
      const { d1, c1 } = await escenario();
      const a = cuerpoDe<{ tireId: string }>(
        await postNeumatico(d1.admin, neumatico()).expect(201),
      );
      const b = cuerpoDe<{ tireId: string }>(
        await postNeumatico(d1.admin, neumatico()).expect(201),
      );
      await evento(d1.admin, a.tireId, { type: 'mount', odometerKm: 1 }).expect(
        400,
      );
      await evento(d1.admin, a.tireId, {
        type: 'mount',
        carId: c1.carId,
        position: 'DI',
      }).expect(400);
      await evento(d1.admin, a.tireId, {
        type: 'mount',
        odometerKm: 1,
        carId: c1.carId,
        position: 'posicion-larga',
      }).expect(400);

      await evento(d1.admin, a.tireId, {
        type: 'mount',
        odometerKm: 5000,
        carId: c1.carId,
        position: 'DI',
      }).expect(201);
      await evento(d1.admin, b.tireId, {
        type: 'mount',
        odometerKm: 5000,
        carId: c1.carId,
        position: 'DI',
      }).expect(409);

      await evento(d1.admin, a.tireId, {
        type: 'unmount',
        odometerKm: 4000,
      }).expect(400);
      await evento(d1.admin, a.tireId, {
        type: 'rotate',
        odometerKm: 5100,
      }).expect(400);
    });

    it('otra distribuidora: no ve ni mueve el neumático, ni monta en un vehículo ajeno (404)', async () => {
      const { d1, d2, c1, c2 } = await escenario();
      const t = cuerpoDe<{ tireId: string }>(
        await postNeumatico(d1.admin, neumatico()).expect(201),
      );
      await http().get(`/fleet/tires/${t.tireId}`).set(d2.admin).expect(404);
      await evento(d2.admin, t.tireId, {
        type: 'retire',
        odometerKm: 1,
      }).expect(404);
      await evento(d1.admin, t.tireId, {
        type: 'mount',
        odometerKm: 1,
        carId: c2.carId,
        position: 'DI',
      }).expect(404);
      await http().get(`/cars/${c1.carId}/tires`).set(d2.admin).expect(404);
    });

    it('lista los neumáticos y los de un vehículo', async () => {
      const { d1, c1 } = await escenario();
      const t = cuerpoDe<{ tireId: string }>(
        await postNeumatico(d1.admin, neumatico()).expect(201),
      );
      await postNeumatico(d1.admin, neumatico()).expect(201);
      await evento(d1.admin, t.tireId, {
        type: 'mount',
        odometerKm: 1,
        carId: c1.carId,
        position: 'DI',
      }).expect(201);

      const todos = cuerpoDe<{ total: number }>(
        await http().get('/fleet/tires').set(d1.admin).expect(200),
      );
      expect(todos.total).toBe(2);
      const montados = cuerpoDe<{ total: number }>(
        await http()
          .get('/fleet/tires?status=mounted')
          .set(d1.admin)
          .expect(200),
      );
      expect(montados.total).toBe(1);
      const delAuto = cuerpoDe<{
        total: number;
        data: Array<{ tireId: string }>;
      }>(await http().get(`/cars/${c1.carId}/tires`).set(d1.admin).expect(200));
      expect(delAuto.total).toBe(1);
      expect(delAuto.data[0].tireId).toBe(t.tireId);
    });
  });

  // ---------------------------------------------------------------------
  // Vehículo: combustible y tanque (CU-034 / CU-111 los reciben)
  // ---------------------------------------------------------------------
  describe('vehículo', () => {
    it('el alta y la modificación del vehículo aceptan el combustible y el tanque, y la respuesta trae kilometraje y estado', async () => {
      const { d1, c1 } = await escenario();
      const res = await http()
        .patch(`/car/${c1.carId}`)
        .set(d1.admin)
        .send({ fuel_type: 'lpg', tank_capacity_liters: 80.5 })
        .expect(200);
      expect(cuerpoDe(res)).toMatchObject({
        fuel_type: 'lpg',
        tank_capacity_liters: 80.5,
        fleet_status: 'active',
        odometer_km: 0,
      });
      await http()
        .patch(`/car/${c1.carId}`)
        .set(d1.admin)
        .send({ fuel_type: 'agua' })
        .expect(400);
      await http()
        .patch(`/car/${c1.carId}`)
        .set(d1.admin)
        .send({ tank_capacity_liters: 0 })
        .expect(400);
    });

    it('cerrar una tarea de mantenimiento con kilometraje sube el del vehículo, sin pisar uno mayor', async () => {
      const { d1, c1 } = await escenario();
      const service = await ds.getRepository(MaintenancePlan).findOneOrFail({
        where: {
          distributorId: d1.distributorId,
          name: 'Service / cambio de aceite',
        },
      });
      const cerrar = async (km: number) => {
        const t = cuerpoDe<{ taskId: string }>(
          await http()
            .post('/fleet/tasks')
            .set(d1.admin)
            .send({ planId: service.planId, carId: c1.carId })
            .expect(201),
        );
        await http()
          .patch(`/fleet/tasks/${t.taskId}/close`)
          .set(d1.admin)
          .send({ performedAt: new Date().toISOString(), odometerKm: km })
          .expect(200);
      };
      await cerrar(50000);
      expect((await autoDe(c1.carId)).odometerKm).toBe(50000);
      await cerrar(40000);
      expect((await autoDe(c1.carId)).odometerKm).toBe(50000);
    });
  });
});

/** Espera a que un efecto asíncrono (un listener de eventos) se cumpla. */
async function esperar(condicion: () => boolean, ms = 5000): Promise<void> {
  const limite = Date.now() + ms;
  while (!condicion()) {
    if (Date.now() > limite) throw new Error('Se agotó la espera');
    await new Promise((r) => setTimeout(r, 50));
  }
}
