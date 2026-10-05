/**
 * Módulo Personal (B-A1) contra la API con Postgres real: puestos, legajos,
 * alta unificada chofer = empleado (con rollback conjunto), egreso con sus
 * efectos, reingreso, cuenta de acceso por categoría, aislamiento entre
 * distribuidoras y el backfill de los choferes y admins existentes.
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
import { FirebaseAuthPort } from '../../src/firebase/ports/firebase-auth.port';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { Admin } from '../../src/admin/entities/admin.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Car } from '../../src/car/entities/car.entity';
import { VehicleAssignment } from '../../src/car/entities/vehicle-assignment.entity';
import { VehicleAssignmentService } from '../../src/car/vehicle-assignment.service';
import {
  Employee,
  EmployeeStatus,
} from '../../src/employee/entities/employee.entity';
import {
  JobPosition,
  JobPositionCategory,
} from '../../src/employee/entities/job-position.entity';
import { EmployeeRulesRegistry } from '../../src/employee/employee-rules.registry';
import { JobPositionService } from '../../src/employee/job-position.service';
import { DocumentSequence } from '../../src/document-sequence/entities/document-sequence.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { BackfillDeEmpleados1791160100000 } from '../../src/migrations/1791160100000-BackfillDeEmpleados';

type Cuerpo = Record<string, unknown>;
type Headers = Record<string, string>;

describe('Personal: puestos y legajos (e2e)', () => {
  let env: TestEnv;
  let dataSource: DataSource;
  let firebaseCreados: string[];
  let firebaseBorrados: string[];

  beforeAll(async () => {
    env = await createTestApp();
    dataSource = env.app.get(DataSource);
    const firebase = env.app.get(FirebaseAuthPort);
    jest.spyOn(firebase, 'createUserSafe').mockImplementation((datos) => {
      const uid = `uid-${datos.email}`;
      firebaseCreados.push(uid);
      return Promise.resolve({ uid } as never);
    });
    jest.spyOn(firebase, 'deleteUserSafe').mockImplementation((uid) => {
      firebaseBorrados.push(uid);
      return Promise.resolve();
    });
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
    firebaseCreados = [];
    firebaseBorrados = [];
    // El alta busca el rol por tipo (lo siembra `npm run seed`).
    for (const tipo of ['admin', 'delivery', 'customer', 'super_admin']) {
      await rol(tipo);
    }
  });

  const http = () => request(env.app.getHttpServer());

  async function rol(type: string): Promise<Role> {
    const roles = dataSource.getRepository(Role);
    return (
      (await roles.findOne({ where: { type } })) ??
      (await roles.save({ type } as Partial<Role>))
    );
  }

  async function seedDistribuidora() {
    const sufijo = randomUUID().slice(0, 8);
    const distribuidora = (await dataSource.getRepository(Distributor).save({
      name: `Distribuidora ${sufijo}`,
      slug: `dist-${sufijo}`,
    } as Partial<Distributor>)) as Distributor;
    await env.app
      .get(JobPositionService)
      .sembrarBase(distribuidora.distributorId);
    return distribuidora;
  }

  async function seedAdmin(distributorId: string) {
    const sufijo = randomUUID().slice(0, 8);
    const email = `admin.${sufijo}@splg.local`;
    const user = (await dataSource.getRepository(User).save({
      email,
      fullName: 'Admin Test',
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol('admin')).roleId,
    } as Partial<User>)) as User;
    await dataSource
      .getRepository(Admin)
      .save({ userId: user.userId, distributorId } as Partial<Admin>);
    const headers: Headers = {
      Authorization: `Bearer ${email}`,
      'X-Client-Source': 'panel-app',
    };
    return { user, headers };
  }

  async function escenario() {
    const d1 = await seedDistribuidora();
    const d2 = await seedDistribuidora();
    const admin1 = await seedAdmin(d1.distributorId);
    const admin2 = await seedAdmin(d2.distributorId);
    return { d1, d2, admin1, admin2 };
  }

  async function puestoDe(
    distributorId: string,
    categoria: JobPositionCategory,
  ): Promise<JobPosition> {
    return dataSource.getRepository(JobPosition).findOneOrFail({
      where: { distributorId, category: categoria },
      order: { createdAt: 'ASC' },
    });
  }

  let contador = 0;
  function nuevoLegajo(
    headers: Headers,
    positionId: string,
    over: Cuerpo = {},
  ) {
    contador++;
    return http()
      .post('/employees')
      .set(headers)
      .send({
        positionId,
        firstName: 'Ana',
        lastName: `Pérez${contador}`,
        documentType: 'dni',
        documentNumber: `3000${String(contador).padStart(4, '0')}`,
        hireDate: '2026-03-01',
        employmentType: 'permanent',
        ...over,
      });
  }

  function altaDeChofer(headers: Headers, over: Cuerpo = {}) {
    const sufijo = randomUUID().slice(0, 8);
    return http()
      .post('/users')
      .set(headers)
      .send({
        email: `chofer.${sufijo}@splg.local`,
        password: 'Test1234',
        full_name: 'Carlos de la Cruz',
        phone_number: telefonoDePrueba(),
        rol: 'delivery',
        ...over,
      });
  }

  const cuenta = (e: unknown) => (e as { userId: string }).userId;
  const cuerpoDe = <T = Cuerpo>(res: { body: unknown }) => res.body as T;

  describe('puestos de trabajo (CU-176)', () => {
    it('una distribuidora con los 5 puestos base los lista con su conteo', async () => {
      const { admin1 } = await escenario();
      const res = await http()
        .get('/job-positions')
        .set(admin1.headers)
        .expect(200);
      const puestos = cuerpoDe<Cuerpo[]>(res);
      expect(puestos.map((p) => p.name).sort()).toEqual([
        'Administración',
        'Ayudante',
        'Chofer',
        'Depósito',
        'Vendedor',
      ]);
      expect(puestos.every((p) => p.activeEmployees === 0)).toBe(true);
    });

    it('crear, nombre repetido sin distinguir mayúsculas (409), modificar y eliminar', async () => {
      const { admin1 } = await escenario();
      const creado = await http()
        .post('/job-positions')
        .set(admin1.headers)
        .send({ name: 'Repartidor', category: 'driver' })
        .expect(201);
      const id = cuerpoDe<{ positionId: string }>(creado).positionId;

      await http()
        .post('/job-positions')
        .set(admin1.headers)
        .send({ name: 'REPARTIDOR', category: 'helper' })
        .expect(409);

      await http()
        .patch(`/job-positions/${id}`)
        .set(admin1.headers)
        .send({ name: 'chofer' })
        .expect(409);
      const editado = await http()
        .patch(`/job-positions/${id}`)
        .set(admin1.headers)
        .send({ name: 'Repartidor 2', isActive: false })
        .expect(200);
      expect(editado.body).toMatchObject({
        name: 'Repartidor 2',
        isActive: false,
      });

      await http()
        .delete(`/job-positions/${id}`)
        .set(admin1.headers)
        .expect(200);
      await http()
        .delete(`/job-positions/${id}`)
        .set(admin1.headers)
        .expect(404);
    });

    it('no se elimina un puesto con empleados activos (409, con la cantidad)', async () => {
      const { d1, admin1 } = await escenario();
      const puesto = await puestoDe(
        d1.distributorId,
        JobPositionCategory.HELPER,
      );
      await nuevoLegajo(admin1.headers, puesto.positionId).expect(201);

      const res = await http()
        .delete(`/job-positions/${puesto.positionId}`)
        .set(admin1.headers)
        .expect(409);
      expect(JSON.stringify(res.body)).toContain('1 empleado');
    });

    it('los puestos de otra distribuidora no se ven ni se tocan (404)', async () => {
      const { d1, admin2 } = await escenario();
      const ajeno = await puestoDe(
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );

      await http()
        .patch(`/job-positions/${ajeno.positionId}`)
        .set(admin2.headers)
        .send({ name: 'Hackeado' })
        .expect(404);
      await http()
        .delete(`/job-positions/${ajeno.positionId}`)
        .set(admin2.headers)
        .expect(404);
      const lista = await http()
        .get('/job-positions')
        .set(admin2.headers)
        .expect(200);
      expect(
        cuerpoDe<{ positionId: string }[]>(lista).some(
          (p) => p.positionId === ajeno.positionId,
        ),
      ).toBe(false);
    });
  });

  describe('legajos (CU-177 a CU-180)', () => {
    it('alta: número de legajo correlativo por distribuidora y estado active', async () => {
      const { d1, d2, admin1, admin2 } = await escenario();
      const p1 = await puestoDe(d1.distributorId, JobPositionCategory.HELPER);
      const p2 = await puestoDe(d2.distributorId, JobPositionCategory.HELPER);

      const a = await nuevoLegajo(admin1.headers, p1.positionId).expect(201);
      const b = await nuevoLegajo(admin1.headers, p1.positionId).expect(201);
      const c = await nuevoLegajo(admin2.headers, p2.positionId).expect(201);

      expect(a.body).toMatchObject({
        fileNumber: '0001',
        status: 'active',
        hasAccount: false,
        userId: null,
        deliveryId: null,
      });
      expect(cuerpoDe(b).fileNumber).toBe('0002');
      expect(cuerpoDe(c).fileNumber).toBe('0001');
    });

    it('documento, CUIL y legajo repetidos son 409; en otra distribuidora no chocan', async () => {
      const { d1, d2, admin1, admin2 } = await escenario();
      const p1 = await puestoDe(d1.distributorId, JobPositionCategory.HELPER);
      const p2 = await puestoDe(d2.distributorId, JobPositionCategory.HELPER);
      await nuevoLegajo(admin1.headers, p1.positionId, {
        documentNumber: '111',
        cuil: '20123456786',
        fileNumber: 'A-1',
      }).expect(201);

      await nuevoLegajo(admin1.headers, p1.positionId, {
        documentNumber: '111',
      }).expect(409);
      await nuevoLegajo(admin1.headers, p1.positionId, {
        cuil: '20-12345678-6',
      }).expect(409);
      await nuevoLegajo(admin1.headers, p1.positionId, {
        fileNumber: 'A-1',
      }).expect(409);

      await nuevoLegajo(admin2.headers, p2.positionId, {
        documentNumber: '111',
        cuil: '20123456786',
        fileNumber: 'A-1',
      }).expect(201);
    });

    it('400 por CUIL con dígito verificador incorrecto, fecha irreal o campos de más; 404/409 por puesto', async () => {
      const { d1, d2, admin1 } = await escenario();
      const propio = await puestoDe(
        d1.distributorId,
        JobPositionCategory.HELPER,
      );
      const ajeno = await puestoDe(
        d2.distributorId,
        JobPositionCategory.HELPER,
      );

      await nuevoLegajo(admin1.headers, propio.positionId, {
        cuil: '20123456785',
      }).expect(400);
      await nuevoLegajo(admin1.headers, propio.positionId, {
        hireDate: '2026-02-30',
      }).expect(400);
      await nuevoLegajo(admin1.headers, propio.positionId, {
        status: 'terminated',
      }).expect(400);
      await nuevoLegajo(admin1.headers, ajeno.positionId).expect(404);

      await http()
        .patch(`/job-positions/${propio.positionId}`)
        .set(admin1.headers)
        .send({ isActive: false })
        .expect(200);
      await nuevoLegajo(admin1.headers, propio.positionId).expect(409);
    });

    it('el listado no trae datos personales; el legajo (GET :id) sí; los filtros funcionan', async () => {
      const { d1, admin1 } = await escenario();
      const ayudante = await puestoDe(
        d1.distributorId,
        JobPositionCategory.HELPER,
      );
      const deposito = await puestoDe(
        d1.distributorId,
        JobPositionCategory.WAREHOUSE,
      );
      const creado = await nuevoLegajo(admin1.headers, ayudante.positionId, {
        firstName: 'Zoe',
        lastName: 'Alvarez',
        cuil: '20123456786',
        addressLine: 'Calle 1',
        emergencyContactName: 'Mamá',
      }).expect(201);
      await nuevoLegajo(admin1.headers, deposito.positionId, {
        firstName: 'Bruno',
        lastName: 'Benítez',
      }).expect(201);
      const id = cuerpoDe<{ employeeId: string }>(creado).employeeId;

      const lista = await http()
        .get('/employees?limit=50')
        .set(admin1.headers)
        .expect(200);
      const { data, total } = cuerpoDe<{ data: Cuerpo[]; total: number }>(
        lista,
      );
      expect(total).toBe(2);
      expect(data.map((e) => e.lastName)).toEqual(['Alvarez', 'Benítez']);
      for (const fila of data) {
        for (const prohibido of [
          'documentNumber',
          'cuil',
          'addressLine',
          'emergencyContactName',
          'birthDate',
          'phone',
          'bankCbu',
        ]) {
          expect(fila).not.toHaveProperty(prohibido);
        }
      }

      const ficha = await http()
        .get(`/employees/${id}`)
        .set(admin1.headers)
        .expect(200);
      expect(ficha.body).toMatchObject({
        cuil: '20123456786',
        addressLine: 'Calle 1',
        emergencyContactName: 'Mamá',
        position: { name: 'Ayudante', category: 'helper' },
      });

      const filtrar = async (qs: string) =>
        cuerpoDe<{ data: Cuerpo[]; total: number }>(
          await http().get(`/employees?${qs}`).set(admin1.headers).expect(200),
        );
      expect((await filtrar('q=BEN')).total).toBe(1);
      expect((await filtrar('q=0002')).total).toBe(1);
      expect((await filtrar(`positionId=${ayudante.positionId}`)).total).toBe(
        1,
      );
      expect((await filtrar('category=warehouse')).total).toBe(1);
      expect((await filtrar('status=terminated')).total).toBe(0);
      expect((await filtrar('hasAccount=true')).total).toBe(0);
      expect((await filtrar('hasAccount=false')).total).toBe(2);
      expect((await filtrar('page=2&limit=1')).data).toHaveLength(1);
      // Reservado para B-A2: se acepta y se ignora.
      expect((await filtrar('documentStatus=expired')).total).toBe(2);
      await http()
        .get('/employees?status=nada')
        .set(admin1.headers)
        .expect(400);
    });

    it('modificar: cambia lo que se manda, controla únicos y no deja vacío lo obligatorio', async () => {
      const { d1, admin1 } = await escenario();
      const puesto = await puestoDe(
        d1.distributorId,
        JobPositionCategory.HELPER,
      );
      const a = cuerpoDe<{ employeeId: string }>(
        await nuevoLegajo(admin1.headers, puesto.positionId, {
          documentNumber: '500',
        }).expect(201),
      );
      await nuevoLegajo(admin1.headers, puesto.positionId, {
        documentNumber: '501',
        cuil: '20123456786',
      }).expect(201);

      const editado = await http()
        .patch(`/employees/${a.employeeId}`)
        .set(admin1.headers)
        .send({ city: 'Posadas', phone: '+5493764000001' })
        .expect(200);
      expect(editado.body).toMatchObject({
        city: 'Posadas',
        documentNumber: '500',
      });

      await http()
        .patch(`/employees/${a.employeeId}`)
        .set(admin1.headers)
        .send({ documentNumber: '501' })
        .expect(409);
      await http()
        .patch(`/employees/${a.employeeId}`)
        .set(admin1.headers)
        .send({ cuil: '20123456786' })
        .expect(409);
      await http()
        .patch(`/employees/${a.employeeId}`)
        .set(admin1.headers)
        .send({ firstName: null })
        .expect(400);
      const sinCiudad = await http()
        .patch(`/employees/${a.employeeId}`)
        .set(admin1.headers)
        .send({ city: null })
        .expect(200);
      expect(cuerpoDe(sinCiudad).city).toBeNull();
    });

    it('eliminar: una alta errónea se da de baja; con cuenta de acceso no (409)', async () => {
      const { d1, admin1 } = await escenario();
      const puesto = await puestoDe(
        d1.distributorId,
        JobPositionCategory.HELPER,
      );
      const a = cuerpoDe<{ employeeId: string }>(
        await nuevoLegajo(admin1.headers, puesto.positionId).expect(201),
      );
      await http()
        .delete(`/employees/${a.employeeId}`)
        .set(admin1.headers)
        .expect(200);
      await http()
        .get(`/employees/${a.employeeId}`)
        .set(admin1.headers)
        .expect(404);

      const chofer = cuerpoDe<{ id?: string }>(
        await altaDeChofer(admin1.headers).expect(201),
      );
      expect(chofer).toBeDefined();
      const conCuenta = await dataSource.getRepository(Employee).findOneOrFail({
        where: {
          distributorId: d1.distributorId,
          userId: Not(IsNull()),
        },
      });
      await http()
        .delete(`/employees/${conCuenta.employeeId}`)
        .set(admin1.headers)
        .expect(409);
    });
  });

  describe('alta unificada chofer = empleado (CU-003 incluye CU-177)', () => {
    it('POST /users con rol delivery crea usuario, chofer y legajo en una transacción', async () => {
      const { d1, admin1 } = await escenario();

      const res = await altaDeChofer(admin1.headers, {
        full_name: 'Carlos de la Cruz',
      }).expect(201);
      const userId = cuerpoDe<{ userId?: string; user_id?: string }>(res);
      const id = userId.userId ?? userId.user_id;

      const empleado = await dataSource.getRepository(Employee).findOneOrFail({
        where: { userId: id },
        relations: { position: true },
      });
      expect(empleado).toMatchObject({
        distributorId: d1.distributorId,
        firstName: 'Carlos',
        lastName: 'de la Cruz',
        fileNumber: '0001',
        documentNumber: 'PENDIENTE-0001',
        status: EmployeeStatus.ACTIVE,
      });
      expect(empleado.position?.category).toBe(JobPositionCategory.DRIVER);
      expect(empleado.notes).toContain('completar DNI y CUIL');

      const ficha = await http()
        .get(`/employees/${empleado.employeeId}`)
        .set(admin1.headers)
        .expect(200);
      const delivery = await dataSource
        .getRepository(Delivery)
        .findOneOrFail({ where: { userId: id } });
      expect(ficha.body).toMatchObject({
        hasAccount: true,
        userId: id,
        deliveryId: delivery.deliveryId,
      });
    });

    it('con los datos del legajo en el cuerpo los usa', async () => {
      const { d1, admin1 } = await escenario();
      const chofer = await puestoDe(
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );

      await altaDeChofer(admin1.headers, {
        legajo: {
          positionId: chofer.positionId,
          documentNumber: '28999888',
          cuil: '20-28999888-9',
          hireDate: '2026-01-15',
          employmentType: 'contractor',
        },
      }).expect(201);

      const empleado = await dataSource
        .getRepository(Employee)
        .findOneOrFail({ where: { distributorId: d1.distributorId } });
      expect(empleado).toMatchObject({
        documentNumber: '28999888',
        hireDate: '2026-01-15',
        employmentType: 'contractor',
        notes: null,
      });
    });

    it('si el legajo falla (documento repetido) se revierte TODO: sin usuario, sin chofer, sin legajo y se borra la cuenta de Firebase', async () => {
      const { d1, admin1 } = await escenario();
      const ayudante = await puestoDe(
        d1.distributorId,
        JobPositionCategory.HELPER,
      );
      await nuevoLegajo(admin1.headers, ayudante.positionId, {
        documentNumber: '777',
      }).expect(201);
      const usuariosAntes = await dataSource.getRepository(User).count();
      const choferesAntes = await dataSource.getRepository(Delivery).count();
      const secuenciaAntes = await dataSource
        .getRepository(DocumentSequence)
        .findOneByOrFail({
          distributorId: d1.distributorId,
          docType: 'employee_file',
        });

      const email = 'repetido@splg.local';
      await altaDeChofer(admin1.headers, {
        email,
        legajo: { documentNumber: '777' },
      }).expect(409);

      expect(await dataSource.getRepository(User).count()).toBe(usuariosAntes);
      expect(await dataSource.getRepository(Delivery).count()).toBe(
        choferesAntes,
      );
      expect(await dataSource.getRepository(Employee).count()).toBe(1);
      expect(firebaseBorrados).toEqual([`uid-${email}`]);
      const secuenciaDespues = await dataSource
        .getRepository(DocumentSequence)
        .findOneByOrFail({
          distributorId: d1.distributorId,
          docType: 'employee_file',
        });
      expect(secuenciaDespues.lastNumber).toBe(secuenciaAntes.lastNumber);
    });

    it('si falla la creación del chofer, tampoco queda el legajo (rollback en el otro sentido)', async () => {
      const { d1, admin1 } = await escenario();
      const sufijo = randomUUID().slice(0, 8);
      // Un teléfono repetido hace fallar el INSERT del usuario antes del legajo.
      await altaDeChofer(admin1.headers, {
        email: `a.${sufijo}@splg.local`,
        phone_number: '+5493764999999',
      }).expect(201);
      await altaDeChofer(admin1.headers, {
        email: `b.${sufijo}@splg.local`,
        phone_number: '+5493764999999',
      }).expect(409);

      expect(
        await dataSource
          .getRepository(Employee)
          .count({ where: { distributorId: d1.distributorId } }),
      ).toBe(1);
    });

    it('con employeeId vincula el legajo existente; con un puesto sin acceso (400) o de otra distribuidora (404) no crea nada', async () => {
      const { d1, d2, admin1 } = await escenario();
      const chofer = await puestoDe(
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const ayudante = await puestoDe(
        d1.distributorId,
        JobPositionCategory.HELPER,
      );
      const choferAjeno = await puestoDe(
        d2.distributorId,
        JobPositionCategory.DRIVER,
      );
      const repo = dataSource.getRepository(Employee);
      const sinCuenta = cuerpoDe<{ employeeId: string }>(
        await nuevoLegajo(admin1.headers, chofer.positionId).expect(201),
      );
      const deAyudante = cuerpoDe<{ employeeId: string }>(
        await nuevoLegajo(admin1.headers, ayudante.positionId).expect(201),
      );
      const [deOtroTenant] = await repo.save([
        repo.create({
          distributorId: d2.distributorId,
          positionId: choferAjeno.positionId,
          fileNumber: '9',
          firstName: 'Ajeno',
          lastName: 'Ajeno',
          documentType: 'dni' as never,
          documentNumber: '1',
          hireDate: '2026-01-01',
          employmentType: 'permanent' as never,
        }),
      ]);
      const usuariosAntes = await dataSource.getRepository(User).count();

      await altaDeChofer(admin1.headers, {
        employeeId: deAyudante.employeeId,
      }).expect(400);
      await altaDeChofer(admin1.headers, {
        employeeId: deOtroTenant.employeeId,
      }).expect(404);
      await altaDeChofer(admin1.headers, {
        employeeId: sinCuenta.employeeId,
        legajo: {},
      }).expect(400);
      expect(await dataSource.getRepository(User).count()).toBe(usuariosAntes);
      expect(firebaseBorrados).toHaveLength(2);

      await altaDeChofer(admin1.headers, {
        employeeId: sinCuenta.employeeId,
      }).expect(201);
      const vinculado = await repo.findOneByOrFail({
        employeeId: sinCuenta.employeeId,
      });
      expect(vinculado.userId).not.toBeNull();
      expect(
        await repo.count({ where: { distributorId: d1.distributorId } }),
      ).toBe(2);

      await altaDeChofer(admin1.headers, {
        employeeId: sinCuenta.employeeId,
      }).expect(409);
    });
  });

  describe('egreso y reingreso (CU-181)', () => {
    async function choferConVehiculo(
      admin: { headers: Headers },
      distributorId: string,
    ) {
      const alta = await altaDeChofer(admin.headers).expect(201);
      const cuerpo = cuerpoDe<{ userId?: string; user_id?: string }>(alta);
      const userId = (cuerpo.userId ?? cuerpo.user_id) as string;
      const delivery = await dataSource
        .getRepository(Delivery)
        .findOneByOrFail({ userId });
      const empleado = await dataSource
        .getRepository(Employee)
        .findOneByOrFail({ userId });
      const auto = await dataSource.getRepository(Car).save({
        distributorId,
        userId,
        carPatent: `TST${randomUUID().slice(0, 6).toUpperCase()}`,
        carBrand: 'Fiat',
        carModel: 'Fiorino',
      } as Partial<Car>);
      await env.app
        .get(VehicleAssignmentService)
        .ponerEnUso(
          delivery.deliveryId,
          auto.carId,
          null,
          distributorId,
          userId,
        );
      await dataSource
        .getRepository(Delivery)
        .update({ deliveryId: delivery.deliveryId }, { isAvailable: true });
      return { userId, delivery, empleado };
    }

    const abiertas = (deliveryId: string) =>
      dataSource
        .getRepository(VehicleAssignment)
        .count({ where: { deliveryId, releasedAt: IsNull() } });

    it('egresar a un chofer: legajo terminated, cuenta bloqueada, chofer deshabilitado y fuera de línea, vehículo liberado', async () => {
      const { d1, admin1 } = await escenario();
      const { userId, delivery, empleado } = await choferConVehiculo(
        admin1,
        d1.distributorId,
      );
      expect(await abiertas(delivery.deliveryId)).toBe(1);

      const res = await http()
        .post(`/employees/${empleado.employeeId}/termination`)
        .set(admin1.headers)
        .send({ terminationDate: '2026-10-04', reason: 'resignation' })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'terminated',
        terminationDate: '2026-10-04',
        terminationReason: 'resignation',
      });

      expect(
        (await dataSource.getRepository(User).findOneByOrFail({ userId }))
          .blocked,
      ).toBe(true);
      const chofer = await dataSource
        .getRepository(Delivery)
        .findOneByOrFail({ deliveryId: delivery.deliveryId });
      expect(chofer.isEnabled).toBe(false);
      expect(chofer.isAvailable).toBe(false);
      expect(await abiertas(delivery.deliveryId)).toBe(0);
      const asignacion = await dataSource
        .getRepository(VehicleAssignment)
        .findOneByOrFail({ deliveryId: delivery.deliveryId });
      expect(asignacion.note).toContain('egreso del legajo');
      expect(asignacion.releasedByUserId).toBe(admin1.user.userId);

      await http()
        .post(`/employees/${empleado.employeeId}/termination`)
        .set(admin1.headers)
        .send({ terminationDate: '2026-10-05', reason: 'other' })
        .expect(409);
    });

    it('fecha anterior al ingreso: 400 y no cambia nada', async () => {
      const { d1, admin1 } = await escenario();
      const { userId, empleado } = await choferConVehiculo(
        admin1,
        d1.distributorId,
      );

      await http()
        .post(`/employees/${empleado.employeeId}/termination`)
        .set(admin1.headers)
        .send({ terminationDate: '2000-01-01', reason: 'dismissal' })
        .expect(400);

      expect(
        (await dataSource.getRepository(Employee).findOneByOrFail({ userId }))
          .status,
      ).toBe(EmployeeStatus.ACTIVE);
      expect(
        (await dataSource.getRepository(User).findOneByOrFail({ userId }))
          .blocked,
      ).toBe(false);
    });

    it('con un pedido en curso: 409 y TODO queda como estaba (rollback completo)', async () => {
      const { d1, admin1 } = await escenario();
      const { userId, delivery, empleado } = await choferConVehiculo(
        admin1,
        d1.distributorId,
      );
      const cliente = (await dataSource.getRepository(User).save({
        email: `cliente.${randomUUID().slice(0, 8)}@splg.local`,
        fullName: 'Cliente',
        phoneNumber: telefonoDePrueba(),
      } as Partial<User>)) as User;
      await dataSource.getRepository(Customer).save({
        userId: cliente.userId,
        notificationToken: 'x',
      } as Partial<Customer>);
      const direccion = (await dataSource.getRepository(UserAddress).save({
        userId: cliente.userId,
        street: 'Calle 1',
        city: 'Posadas',
        latitude: '-27.36',
        longitude: '-55.89',
      } as Partial<UserAddress>)) as UserAddress;
      await dataSource.getRepository(Order).save({
        customerId: cliente.userId,
        distributorId: d1.distributorId,
        addressId: direccion.addressId,
        status: OrderStatus.ON_THE_WAY,
        paymentMethod: PaymentMethod.CASH,
        totalAmount: 1000,
        subtotalItems: 1000,
        deliveryId: delivery.deliveryId,
        acceptedAt: new Date(),
      } as Partial<Order>);

      await http()
        .post(`/employees/${empleado.employeeId}/termination`)
        .set(admin1.headers)
        .send({ terminationDate: '2026-10-04', reason: 'resignation' })
        .expect(409);

      expect(
        (await dataSource.getRepository(Employee).findOneByOrFail({ userId }))
          .status,
      ).toBe(EmployeeStatus.ACTIVE);
      expect(
        (await dataSource.getRepository(User).findOneByOrFail({ userId }))
          .blocked,
      ).toBe(false);
      expect(
        (await dataSource.getRepository(Delivery).findOneByOrFail({ userId }))
          .isEnabled,
      ).toBe(true);
      expect(await abiertas(delivery.deliveryId)).toBe(1);
    });

    it('sin cuenta: sólo cambia el legajo. Reingreso: activo con fecha nueva, sin desbloquear la cuenta', async () => {
      const { d1, admin1 } = await escenario();
      const ayudante = await puestoDe(
        d1.distributorId,
        JobPositionCategory.HELPER,
      );
      const e = cuerpoDe<{ employeeId: string }>(
        await nuevoLegajo(admin1.headers, ayudante.positionId).expect(201),
      );
      await http()
        .post(`/employees/${e.employeeId}/reinstatement`)
        .set(admin1.headers)
        .send({})
        .expect(409);

      await http()
        .post(`/employees/${e.employeeId}/termination`)
        .set(admin1.headers)
        .send({ terminationDate: '2026-09-30', reason: 'end_of_contract' })
        .expect(200);
      await http()
        .post(`/employees/${e.employeeId}/reinstatement`)
        .set(admin1.headers)
        .send({ hireDate: '2026-09-01' })
        .expect(400);
      const reingreso = await http()
        .post(`/employees/${e.employeeId}/reinstatement`)
        .set(admin1.headers)
        .send({ hireDate: '2026-10-05' })
        .expect(200);
      expect(reingreso.body).toMatchObject({
        status: 'active',
        hireDate: '2026-10-05',
        terminationDate: null,
        terminationReason: null,
      });
    });

    it('el reingreso de un chofer no desbloquea su cuenta', async () => {
      const { d1, admin1 } = await escenario();
      const { userId, empleado } = await choferConVehiculo(
        admin1,
        d1.distributorId,
      );
      await http()
        .post(`/employees/${empleado.employeeId}/termination`)
        .set(admin1.headers)
        .send({ terminationDate: '2026-10-04', reason: 'retirement' })
        .expect(200);
      await http()
        .post(`/employees/${empleado.employeeId}/reinstatement`)
        .set(admin1.headers)
        .send({ hireDate: '2026-10-04' })
        .expect(200);
      expect(
        (await dataSource.getRepository(User).findOneByOrFail({ userId }))
          .blocked,
      ).toBe(true);
    });
  });

  describe('otorgar cuenta de acceso (CU-182)', () => {
    const credenciales = (over: Cuerpo = {}) => ({
      email: `nuevo.${randomUUID().slice(0, 8)}@splg.local`,
      password: 'Test1234',
      phoneNumber: telefonoDePrueba(),
      ...over,
    });

    async function legajoDe(
      admin: { headers: Headers },
      distributorId: string,
      categoria: JobPositionCategory,
    ) {
      const puesto = await puestoDe(distributorId, categoria);
      return cuerpoDe<{ employeeId: string }>(
        await nuevoLegajo(admin.headers, puesto.positionId).expect(201),
      );
    }

    it('sólo el chofer tiene cuenta: cualquier otra categoría (incluida administración y gerencia) es 400', async () => {
      const { d1, admin1 } = await escenario();
      for (const categoria of [
        JobPositionCategory.HELPER,
        JobPositionCategory.WAREHOUSE,
        JobPositionCategory.SALES,
        JobPositionCategory.ADMINISTRATION,
        JobPositionCategory.MANAGEMENT,
        JobPositionCategory.OTHER,
      ]) {
        await dataSource
          .getRepository(JobPosition)
          .findOneBy({ distributorId: d1.distributorId, category: categoria })
          .then((existe) =>
            existe
              ? null
              : dataSource.getRepository(JobPosition).save({
                  distributorId: d1.distributorId,
                  name: `Puesto ${categoria}`,
                  category: categoria,
                } as Partial<JobPosition>),
          );
        const e = await legajoDe(admin1, d1.distributorId, categoria);
        const res = await http()
          .post(`/employees/${e.employeeId}/account`)
          .set(admin1.headers)
          .send(credenciales())
          .expect(400);
        expect(JSON.stringify(res.body)).toContain(
          'Sólo los choferes tienen cuenta',
        );
      }
      expect(firebaseCreados).toHaveLength(0);
    });

    it('un chofer recibe rol delivery y su perfil de reparto; un administrativo no puede recibir cuenta', async () => {
      const { d1, admin1 } = await escenario();
      const chofer = await legajoDe(
        admin1,
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const administrativo = await legajoDe(
        admin1,
        d1.distributorId,
        JobPositionCategory.ADMINISTRATION,
      );

      const resChofer = await http()
        .post(`/employees/${chofer.employeeId}/account`)
        .set(admin1.headers)
        .send(credenciales())
        .expect(200);
      const userIdChofer = cuenta(resChofer.body);
      const usuario = await dataSource.getRepository(User).findOneOrFail({
        where: { userId: userIdChofer },
        relations: { role: true },
      });
      expect(usuario.role?.type).toBe('delivery');
      expect(usuario.fullName).toMatch(/^Ana /);
      const perfil = await dataSource
        .getRepository(Delivery)
        .findOneByOrFail({ userId: userIdChofer });
      expect(perfil.distributorId).toBe(d1.distributorId);
      expect(resChofer.body).toMatchObject({
        hasAccount: true,
        deliveryId: perfil.deliveryId,
      });

      await http()
        .post(`/employees/${administrativo.employeeId}/account`)
        .set(admin1.headers)
        .send(credenciales())
        .expect(400);
    });

    it('ya tiene cuenta (409), está egresado (409), correo repetido (409 y sigue sin cuenta), teléfono inválido (400)', async () => {
      const { d1, admin1 } = await escenario();
      const e = await legajoDe(
        admin1,
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const otro = await legajoDe(
        admin1,
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const url = (id: string) => `/employees/${id}/account`;

      const primera = credenciales();
      await http()
        .post(url(e.employeeId))
        .set(admin1.headers)
        .send(primera)
        .expect(200);
      await http()
        .post(url(e.employeeId))
        .set(admin1.headers)
        .send(credenciales())
        .expect(409);

      await http()
        .post(url(otro.employeeId))
        .set(admin1.headers)
        .send(credenciales({ email: primera.email }))
        .expect(409);
      await http()
        .post(url(otro.employeeId))
        .set(admin1.headers)
        .send(credenciales({ phoneNumber: '1234' }))
        .expect(400);
      expect(
        (
          await dataSource
            .getRepository(Employee)
            .findOneByOrFail({ employeeId: otro.employeeId })
        ).userId,
      ).toBeNull();

      await http()
        .post(`/employees/${otro.employeeId}/termination`)
        .set(admin1.headers)
        .send({ terminationDate: '2026-10-04', reason: 'other' })
        .expect(200);
      await http()
        .post(url(otro.employeeId))
        .set(admin1.headers)
        .send(credenciales())
        .expect(409);
    });
  });

  describe('correcciones de la revisión cruzada', () => {
    it('el legajo automático salta los números que alguien cargó a mano (POST y PATCH)', async () => {
      const { d1, admin1 } = await escenario();
      const ayudante = await puestoDe(
        d1.distributorId,
        JobPositionCategory.HELPER,
      );
      await nuevoLegajo(admin1.headers, ayudante.positionId, {
        fileNumber: '0001',
      }).expect(201);
      const b = await nuevoLegajo(admin1.headers, ayudante.positionId).expect(
        201,
      );
      expect(cuerpoDe(b).fileNumber).toBe('0002');
      const c = cuerpoDe<{ employeeId: string }>(
        await nuevoLegajo(admin1.headers, ayudante.positionId).expect(201),
      );
      // Se adelanta el siguiente número (0004) editando un legajo.
      await http()
        .patch(`/employees/${c.employeeId}`)
        .set(admin1.headers)
        .send({ fileNumber: '0004' })
        .expect(200);

      const chofer = await altaDeChofer(admin1.headers).expect(201);
      expect(chofer.status).toBe(201);
      const nuevo = await dataSource
        .getRepository(Employee)
        .findOneByOrFail({ documentNumber: 'PENDIENTE-0005' });
      expect(nuevo.fileNumber).toBe('0005');
    });

    it('no se elimina un puesto referenciado por un legajo egresado (409) y no se borra físicamente', async () => {
      const { d1, admin1 } = await escenario();
      const puesto = await puestoDe(
        d1.distributorId,
        JobPositionCategory.HELPER,
      );
      const e = cuerpoDe<{ employeeId: string }>(
        await nuevoLegajo(admin1.headers, puesto.positionId).expect(201),
      );
      await http()
        .post(`/employees/${e.employeeId}/termination`)
        .set(admin1.headers)
        .send({ terminationDate: '2026-10-04', reason: 'other' })
        .expect(200);

      const res = await http()
        .delete(`/job-positions/${puesto.positionId}`)
        .set(admin1.headers)
        .expect(409);
      expect(JSON.stringify(res.body)).toContain('isActive=false');
      await http()
        .get(`/employees/${e.employeeId}`)
        .set(admin1.headers)
        .expect(200);

      // Desactivarlo sí se puede, y el legajo egresado se sigue viendo.
      await http()
        .patch(`/job-positions/${puesto.positionId}`)
        .set(admin1.headers)
        .send({ isActive: false })
        .expect(200);
    });

    it('DELETE de puesto y de legajo son bajas lógicas: la fila queda con deletedAt', async () => {
      const { d1, admin1 } = await escenario();
      const puesto = await http()
        .post('/job-positions')
        .set(admin1.headers)
        .send({ name: 'Temporal', category: 'other' })
        .expect(201);
      const positionId = cuerpoDe<{ positionId: string }>(puesto).positionId;
      const e = cuerpoDe<{ employeeId: string }>(
        await nuevoLegajo(
          admin1.headers,
          (await puestoDe(d1.distributorId, JobPositionCategory.HELPER))
            .positionId,
        ).expect(201),
      );

      await http()
        .delete(`/employees/${e.employeeId}`)
        .set(admin1.headers)
        .expect(200);
      await http()
        .delete(`/job-positions/${positionId}`)
        .set(admin1.headers)
        .expect(200);

      const legajo = await dataSource.getRepository(Employee).findOneOrFail({
        where: { employeeId: e.employeeId },
        withDeleted: true,
      });
      const borrado = await dataSource
        .getRepository(JobPosition)
        .findOneOrFail({ where: { positionId }, withDeleted: true });
      expect(legajo.deletedAt).not.toBeNull();
      expect(borrado.deletedAt).not.toBeNull();
    });

    it('recategorizar un puesto con una cuenta de rol incompatible es 409', async () => {
      const { d1, admin1 } = await escenario();
      const chofer = await altaDeChofer(admin1.headers).expect(201);
      expect(chofer.status).toBe(201);
      const empleado = await dataSource
        .getRepository(Employee)
        .findOneOrFail({ where: { distributorId: d1.distributorId } });
      // Un segundo puesto de chofer, para que el primero no sea el último.
      await http()
        .post('/job-positions')
        .set(admin1.headers)
        .send({ name: 'Chofer 2', category: 'driver' })
        .expect(201);

      await http()
        .patch(`/job-positions/${empleado.positionId}`)
        .set(admin1.headers)
        .send({ category: 'warehouse' })
        .expect(409);
      const intacto = await dataSource
        .getRepository(JobPosition)
        .findOneByOrFail({ positionId: empleado.positionId });
      expect(intacto.category).toBe(JobPositionCategory.DRIVER);
    });

    it('no se puede desactivar, recategorizar ni eliminar el último puesto activo de chofer', async () => {
      const { d1, admin1 } = await escenario();
      const unico = await puestoDe(
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const url = `/job-positions/${unico.positionId}`;

      await http()
        .patch(url)
        .set(admin1.headers)
        .send({ isActive: false })
        .expect(409);
      await http()
        .patch(url)
        .set(admin1.headers)
        .send({ category: 'other' })
        .expect(409);
      await http().delete(url).set(admin1.headers).expect(409);

      await http()
        .post('/job-positions')
        .set(admin1.headers)
        .send({ name: 'Otro chofer', category: 'driver' })
        .expect(201);
      await http()
        .patch(url)
        .set(admin1.headers)
        .send({ isActive: false })
        .expect(200);
      // Y el alta de choferes sigue funcionando con el que queda.
      await altaDeChofer(admin1.headers).expect(201);
    });

    it('los opcionales vacíos ("") se tratan como no informados', async () => {
      const { d1, admin1 } = await escenario();
      const puesto = await puestoDe(
        d1.distributorId,
        JobPositionCategory.HELPER,
      );
      const e = await nuevoLegajo(admin1.headers, puesto.positionId, {
        cuil: '',
        birthDate: '',
        phone: '',
        notes: '   ',
        bankCbu: '',
        fileNumber: '',
      }).expect(201);
      expect(e.body).toMatchObject({
        cuil: null,
        birthDate: null,
        phone: null,
        notes: null,
        bankCbu: null,
        fileNumber: '0001',
      });

      const id = cuerpoDe<{ employeeId: string }>(e).employeeId;
      await http()
        .patch(`/employees/${id}`)
        .set(admin1.headers)
        .send({ cuil: '20123456786' })
        .expect(200);
      const borrado = await http()
        .patch(`/employees/${id}`)
        .set(admin1.headers)
        .send({ cuil: '' })
        .expect(200);
      expect(cuerpoDe(borrado).cuil).toBeNull();
    });

    it('POST /users: employeeId o legajo con rol customer o super_admin es 400', async () => {
      const { admin1 } = await escenario();
      await altaDeChofer(admin1.headers, {
        rol: 'customer',
        employeeId: randomUUID(),
      }).expect(400);
      await altaDeChofer(admin1.headers, {
        rol: 'customer',
        legajo: {},
      }).expect(400);
      expect(firebaseCreados).toHaveLength(0);
    });

    it('un admin nuevo (POST /users) también crea su legajo en el puesto de administración, con rollback conjunto', async () => {
      const { d1, admin1 } = await escenario();
      const sufijo = randomUUID().slice(0, 8);
      const res = await altaDeChofer(admin1.headers, {
        rol: 'admin',
        email: `admin.nuevo.${sufijo}@splg.local`,
        full_name: 'Laura Gómez',
      }).expect(201);
      const body = cuerpoDe<{ userId?: string; user_id?: string }>(res);
      const empleado = await dataSource.getRepository(Employee).findOneOrFail({
        where: { userId: body.userId ?? body.user_id },
        relations: { position: true },
      });
      expect(empleado.position?.category).toBe(
        JobPositionCategory.ADMINISTRATION,
      );
      expect(empleado).toMatchObject({
        firstName: 'Laura',
        lastName: 'Gómez',
        distributorId: d1.distributorId,
      });

      // Si el legajo falla (documento repetido) no queda ni el usuario ni el perfil de admin.
      const usuarios = await dataSource.getRepository(User).count();
      const admins = await dataSource.getRepository(Admin).count();
      const email = `admin.falla.${sufijo}@splg.local`;
      await altaDeChofer(admin1.headers, {
        rol: 'admin',
        email,
        legajo: { documentNumber: empleado.documentNumber },
      }).expect(409);
      expect(await dataSource.getRepository(User).count()).toBe(usuarios);
      expect(await dataSource.getRepository(Admin).count()).toBe(admins);
      expect(firebaseBorrados).toContain(`uid-${email}`);
    });

    it('DELETE /users/:id de un chofer egresa su legajo en la misma baja (motivo other, "Baja del usuario")', async () => {
      const { admin1 } = await escenario();
      const alta = await altaDeChofer(admin1.headers).expect(201);
      const cuerpo = cuerpoDe<{ userId?: string; user_id?: string }>(alta);
      const userId = (cuerpo.userId ?? cuerpo.user_id) as string;

      const antes = await dataSource
        .getRepository(Employee)
        .findOneByOrFail({ userId });

      await http().delete(`/users/${userId}`).set(admin1.headers).expect(200);

      const empleado = await dataSource
        .getRepository(Employee)
        .findOneByOrFail({ employeeId: antes.employeeId });
      expect(empleado).toMatchObject({
        status: EmployeeStatus.TERMINATED,
        terminationReason: 'other',
        // La cuenta ya no existe: el legajo la suelta.
        userId: null,
      });
      expect(empleado.terminationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(empleado.notes).toContain('Baja del usuario');
    });

    it('si la baja del chofer se revierte (pedido en curso), el legajo sigue activo', async () => {
      const { d1, admin1 } = await escenario();
      const alta = await altaDeChofer(admin1.headers).expect(201);
      const cuerpo = cuerpoDe<{ userId?: string; user_id?: string }>(alta);
      const userId = (cuerpo.userId ?? cuerpo.user_id) as string;
      const delivery = await dataSource
        .getRepository(Delivery)
        .findOneByOrFail({ userId });
      const cliente = (await dataSource.getRepository(User).save({
        email: `cli.${randomUUID().slice(0, 8)}@splg.local`,
        fullName: 'Cliente',
        phoneNumber: telefonoDePrueba(),
      } as Partial<User>)) as User;
      await dataSource.getRepository(Customer).save({
        userId: cliente.userId,
        notificationToken: 'x',
      } as Partial<Customer>);
      const direccion = (await dataSource.getRepository(UserAddress).save({
        userId: cliente.userId,
        street: 'Calle 1',
        city: 'Posadas',
        latitude: '-27.36',
        longitude: '-55.89',
      } as Partial<UserAddress>)) as UserAddress;
      await dataSource.getRepository(Order).save({
        customerId: cliente.userId,
        distributorId: d1.distributorId,
        addressId: direccion.addressId,
        status: OrderStatus.ACCEPTED,
        paymentMethod: PaymentMethod.CASH,
        totalAmount: 1000,
        subtotalItems: 1000,
        deliveryId: delivery.deliveryId,
        acceptedAt: new Date(),
      } as Partial<Order>);

      await http().delete(`/users/${userId}`).set(admin1.headers).expect(409);

      expect(
        (await dataSource.getRepository(Employee).findOneByOrFail({ userId }))
          .status,
      ).toBe(EmployeeStatus.ACTIVE);
    });
  });

  describe('ronda 3 de la revisión cruzada', () => {
    const idDe = (res: { body: unknown }) => {
      const b = res.body as { userId?: string; user_id?: string };
      return (b.userId ?? b.user_id) as string;
    };

    it('baja de usuario, reingreso y cuenta nueva: el legajo puede volver a recibir acceso', async () => {
      const { admin1 } = await escenario();
      const userId = idDe(await altaDeChofer(admin1.headers).expect(201));
      const legajo = await dataSource
        .getRepository(Employee)
        .findOneByOrFail({ userId });

      await http().delete(`/users/${userId}`).set(admin1.headers).expect(200);
      await http()
        .post(`/employees/${legajo.employeeId}/reinstatement`)
        .set(admin1.headers)
        .send({})
        .expect(200);
      const res = await http()
        .post(`/employees/${legajo.employeeId}/account`)
        .set(admin1.headers)
        .send({
          email: `otra.${randomUUID().slice(0, 8)}@splg.local`,
          password: 'Test1234',
          phoneNumber: telefonoDePrueba(),
        })
        .expect(200);
      expect(res.body).toMatchObject({ hasAccount: true, status: 'active' });
      expect(cuenta(res.body)).not.toBe(userId);
    });

    it('la baja de un admin también egresa su legajo y suelta la cuenta', async () => {
      const { admin1 } = await escenario();
      const userId = idDe(
        await altaDeChofer(admin1.headers, {
          rol: 'admin',
          email: `adm.${randomUUID().slice(0, 8)}@splg.local`,
        }).expect(201),
      );
      const legajo = await dataSource
        .getRepository(Employee)
        .findOneByOrFail({ userId });

      await http().delete(`/users/${userId}`).set(admin1.headers).expect(200);

      expect(
        await dataSource
          .getRepository(Employee)
          .findOneByOrFail({ employeeId: legajo.employeeId }),
      ).toMatchObject({ status: EmployeeStatus.TERMINATED, userId: null });
    });

    it('si una precondición del egreso lo impide, la baja del usuario falla con 409 y se revierte todo', async () => {
      const { admin1 } = await escenario();
      const userId = idDe(await altaDeChofer(admin1.headers).expect(201));
      let impedir = true;
      env.app
        .get(EmployeeRulesRegistry)
        .alEgresar(() =>
          Promise.resolve(impedir ? ['tiene una rendición pendiente'] : []),
        );

      const res = await http()
        .delete(`/users/${userId}`)
        .set(admin1.headers)
        .expect(409);
      expect(JSON.stringify(res.body)).toContain('rendición pendiente');
      expect(
        (await dataSource.getRepository(User).findOneByOrFail({ userId }))
          .deletedAt,
      ).toBeNull();
      expect(
        await dataSource.getRepository(Employee).findOneByOrFail({ userId }),
      ).toMatchObject({ status: EmployeeStatus.ACTIVE });
      impedir = false;
    });

    it('egreso del legajo y baja del usuario a la vez no dan deadlock ni 500', async () => {
      const { admin1 } = await escenario();
      for (let i = 0; i < 4; i++) {
        const userId = idDe(await altaDeChofer(admin1.headers).expect(201));
        const legajo = await dataSource
          .getRepository(Employee)
          .findOneByOrFail({ userId });
        const [a, b] = await Promise.all([
          http()
            .post(`/employees/${legajo.employeeId}/termination`)
            .set(admin1.headers)
            .send({ terminationDate: '2026-10-04', reason: 'other' }),
          http().delete(`/users/${userId}`).set(admin1.headers),
        ]);
        expect([200, 404, 409]).toContain(a.status);
        expect([200, 404, 409]).toContain(b.status);
      }
    });

    it('el último puesto activo de administración también está protegido', async () => {
      const { d1, admin1 } = await escenario();
      const unico = await puestoDe(
        d1.distributorId,
        JobPositionCategory.ADMINISTRATION,
      );
      const url = `/job-positions/${unico.positionId}`;
      await http()
        .patch(url)
        .set(admin1.headers)
        .send({ isActive: false })
        .expect(409);
      await http()
        .patch(url)
        .set(admin1.headers)
        .send({ category: 'other' })
        .expect(409);
      await http().delete(url).set(admin1.headers).expect(409);
    });

    it('el alta de admin usa un puesto de gerencia si no hay uno de administración activo', async () => {
      const { d1, admin1 } = await escenario();
      await dataSource.getRepository(JobPosition).update(
        {
          distributorId: d1.distributorId,
          category: JobPositionCategory.ADMINISTRATION,
        },
        { category: JobPositionCategory.MANAGEMENT, name: 'Gerencia' },
      );
      const userId = idDe(
        await altaDeChofer(admin1.headers, {
          rol: 'admin',
          email: `ger.${randomUUID().slice(0, 8)}@splg.local`,
        }).expect(201),
      );
      const legajo = await dataSource
        .getRepository(Employee)
        .findOneOrFail({ where: { userId }, relations: { position: true } });
      expect(legajo.position?.category).toBe(JobPositionCategory.MANAGEMENT);
    });

    it('los mensajes de 409 de los únicos no incluyen el documento ni el CUIL', async () => {
      const { d1, admin1 } = await escenario();
      const puesto = await puestoDe(
        d1.distributorId,
        JobPositionCategory.HELPER,
      );
      await nuevoLegajo(admin1.headers, puesto.positionId, {
        documentNumber: '55667788',
        cuil: '20123456786',
      }).expect(201);
      const dni = await nuevoLegajo(admin1.headers, puesto.positionId, {
        documentNumber: '55667788',
      }).expect(409);
      const cuil = await nuevoLegajo(admin1.headers, puesto.positionId, {
        cuil: '20123456786',
      }).expect(409);
      expect(JSON.stringify(dni.body)).not.toContain('55667788');
      expect(JSON.stringify(cuil.body)).not.toContain('20123456786');
    });

    it('borrar un puesto y dar de alta un legajo en él a la vez: nunca queda un legajo en un puesto borrado', async () => {
      const { d1, admin1 } = await escenario();
      for (let i = 0; i < 4; i++) {
        const creado = await http()
          .post('/job-positions')
          .set(admin1.headers)
          .send({ name: `Carrera ${i}`, category: 'other' })
          .expect(201);
        const positionId = cuerpoDe<{ positionId: string }>(creado).positionId;
        const [borrado, alta] = await Promise.all([
          http().delete(`/job-positions/${positionId}`).set(admin1.headers),
          nuevoLegajo(admin1.headers, positionId),
        ]);
        expect([200, 409]).toContain(borrado.status);
        expect([201, 404, 409]).toContain(alta.status);
        const huerfanos: unknown[] = await dataSource.query(
          `SELECT 1 FROM employee e JOIN job_position p ON p.position_id = e.position_id
           WHERE p."deletedAt" IS NOT NULL AND e."deletedAt" IS NULL AND e.distributor_id = $1`,
          [d1.distributorId],
        );
        expect(huerfanos).toHaveLength(0);
      }
    });

    it('altas simultáneas sobre una distribuidora sin puestos no dan 409 por la siembra', async () => {
      await escenario();
      const sufijo = randomUUID().slice(0, 8);
      const d = (await dataSource.getRepository(Distributor).save({
        name: `Sin puestos ${sufijo}`,
        slug: `sp-${sufijo}`,
      } as Partial<Distributor>)) as Distributor;
      const admin = await seedAdmin(d.distributorId);
      const respuestas = await Promise.all(
        [1, 2, 3].map(() => altaDeChofer(admin.headers)),
      );
      expect(respuestas.map((r) => r.status)).toEqual([201, 201, 201]);
    });
  });

  describe('aislamiento entre distribuidoras', () => {
    it('un admin no ve ni toca los empleados de otra distribuidora (404 en todo)', async () => {
      const { d1, admin1, admin2 } = await escenario();
      const puesto = await puestoDe(
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const e = cuerpoDe<{ employeeId: string }>(
        await nuevoLegajo(admin1.headers, puesto.positionId).expect(201),
      );
      const id = e.employeeId;
      const cuentas = await dataSource.getRepository(User).count();

      await http().get(`/employees/${id}`).set(admin2.headers).expect(404);
      await http()
        .patch(`/employees/${id}`)
        .set(admin2.headers)
        .send({ city: 'X' })
        .expect(404);
      await http().delete(`/employees/${id}`).set(admin2.headers).expect(404);
      await http()
        .post(`/employees/${id}/termination`)
        .set(admin2.headers)
        .send({ terminationDate: '2026-10-04', reason: 'other' })
        .expect(404);
      await http()
        .post(`/employees/${id}/reinstatement`)
        .set(admin2.headers)
        .send({})
        .expect(404);
      await http()
        .post(`/employees/${id}/account`)
        .set(admin2.headers)
        .send({
          email: 'x@splg.local',
          password: 'Test1234',
          phoneNumber: '+5493764000002',
        })
        .expect(404);

      const lista = await http()
        .get('/employees')
        .set(admin2.headers)
        .expect(200);
      expect(cuerpoDe<{ total: number }>(lista).total).toBe(0);
      const propio = await http()
        .get(`/employees/${id}`)
        .set(admin1.headers)
        .expect(200);
      expect(propio.body).toMatchObject({ status: 'active', city: null });
      expect(await dataSource.getRepository(User).count()).toBe(cuentas);
    });

    it('el super admin sin distribuidora en contexto recibe 400 en vez de ver todo', async () => {
      const { d1 } = await escenario();
      const sufijo = randomUUID().slice(0, 8);
      const email = `super.${sufijo}@splg.local`;
      const user = (await dataSource.getRepository(User).save({
        email,
        fullName: 'Super',
        phoneNumber: telefonoDePrueba(),
        roleId: (await rol('super_admin')).roleId,
      } as Partial<User>)) as User;
      await dataSource
        .getRepository(Admin)
        .save({ userId: user.userId, distributorId: null } as Partial<Admin>);
      const headers = {
        Authorization: `Bearer ${email}`,
        'X-Client-Source': 'panel-app',
      };

      await http().get('/employees').set(headers).expect(400);
      const conContexto = await http()
        .get('/employees')
        .set({ ...headers, 'X-Distributor': d1.slug })
        .expect(200);
      expect(cuerpoDe<{ total: number }>(conContexto).total).toBe(0);
    });
  });

  describe('backfill de los choferes y admins existentes (migración)', () => {
    async function ejecutar(direccion: 'up' | 'down') {
      const runner = dataSource.createQueryRunner();
      try {
        const migracion = new BackfillDeEmpleados1791160100000();
        await migracion[direccion](runner);
      } finally {
        await runner.release();
      }
    }

    async function seedPreexistentes() {
      const d = await seedDistribuidora();
      const roles = {
        delivery: await rol('delivery'),
        admin: await rol('admin'),
      };
      const crear = async (
        nombre: string | null,
        tipo: 'delivery' | 'admin',
        creadoEn: string,
      ) => {
        const sufijo = randomUUID().slice(0, 8);
        const user = (await dataSource.getRepository(User).save({
          email: `${tipo}.${sufijo}@splg.local`,
          fullName: nombre,
          phoneNumber: telefonoDePrueba(),
          roleId: roles[tipo].roleId,
        } as unknown as Partial<User>)) as User;
        if (tipo === 'delivery') {
          const delivery = (await dataSource.getRepository(Delivery).save({
            userId: user.userId,
            distributorId: d.distributorId,
          } as Partial<Delivery>)) as Delivery;
          await dataSource
            .getRepository(Delivery)
            .update(
              { deliveryId: delivery.deliveryId },
              { createdAt: new Date(creadoEn) },
            );
        } else {
          const admin = (await dataSource.getRepository(Admin).save({
            userId: user.userId,
            distributorId: d.distributorId,
          } as Partial<Admin>)) as Admin;
          await dataSource
            .getRepository(Admin)
            .update(
              { adminId: admin.adminId },
              { createdAt: new Date(creadoEn) },
            );
        }
        return user;
      };
      const juan = await crear(
        'Juan Carlos de la Cruz',
        'delivery',
        '2026-03-10T01:00:00Z',
      );
      const madonna = await crear(
        'Madonna',
        'delivery',
        '2026-03-11T12:00:00Z',
      );
      const laura = await crear('Laura Gómez', 'admin', '2026-04-01T12:00:00Z');
      const borrado = await crear(
        'Chofer Borrado',
        'delivery',
        '2026-04-02T12:00:00Z',
      );
      await dataSource
        .getRepository(User)
        .softDelete({ userId: borrado.userId });
      await dataSource
        .getRepository(Delivery)
        .softDelete({ userId: borrado.userId });
      return { d, juan, madonna, laura, borrado };
    }

    it('crea un legajo por chofer vigente y por admin, con nombre partido, documento pendiente y fecha de alta', async () => {
      const { d, juan, madonna, laura, borrado } = await seedPreexistentes();

      await ejecutar('up');

      const repo = dataSource.getRepository(Employee);
      const de = (userId: string) =>
        repo.findOneOrFail({
          where: { userId },
          relations: { position: true },
        });
      expect(await repo.count()).toBe(3);
      expect(await repo.findOneBy({ userId: borrado.userId })).toBeNull();

      const eJuan = await de(juan.userId);
      expect(eJuan).toMatchObject({
        firstName: 'Juan Carlos',
        lastName: 'de la Cruz',
        fileNumber: '0001',
        documentNumber: 'PENDIENTE-0001',
        hireDate: '2026-03-09',
        status: EmployeeStatus.ACTIVE,
        distributorId: d.distributorId,
      });
      expect(eJuan.position?.name).toBe('Chofer');
      expect(eJuan.notes).toContain('completar DNI y CUIL');
      expect(await de(madonna.userId)).toMatchObject({
        firstName: 'Madonna',
        lastName: 'Sin apellido',
        fileNumber: '0002',
      });
      const eLaura = await de(laura.userId);
      expect(eLaura.position?.name).toBe('Administración');
      expect(eLaura.fileNumber).toBe('0003');

      const secuencia = await dataSource
        .getRepository(DocumentSequence)
        .findOneByOrFail({
          distributorId: d.distributorId,
          docType: 'employee_file',
        });
      expect(secuencia.lastNumber).toBe(3);
    });

    it('es idempotente: correrla de nuevo no duplica nada ni gasta números', async () => {
      const { d } = await seedPreexistentes();
      await ejecutar('up');
      await ejecutar('up');

      expect(await dataSource.getRepository(Employee).count()).toBe(3);
      const secuencia = await dataSource
        .getRepository(DocumentSequence)
        .findOneByOrFail({
          distributorId: d.distributorId,
          docType: 'employee_file',
        });
      expect(secuencia.lastNumber).toBe(3);
    });

    it('es reversible: down borra los legajos generados, respeta los demás y reajusta la secuencia', async () => {
      const { d, admin } = await (async () => {
        const base = await seedPreexistentes();
        const admin = await seedAdmin(base.d.distributorId);
        return { ...base, admin };
      })();
      const ayudante = await puestoDe(
        d.distributorId,
        JobPositionCategory.HELPER,
      );
      // Un legajo cargado a mano antes de correr el backfill (legajo 0001 ocupado).
      await dataSource.getRepository(Employee).save(
        dataSource.getRepository(Employee).create({
          distributorId: d.distributorId,
          positionId: ayudante.positionId,
          fileNumber: '0001',
          firstName: 'A mano',
          lastName: 'A mano',
          documentType: 'dni' as never,
          documentNumber: '42',
          hireDate: '2026-01-01',
          employmentType: 'permanent' as never,
        }),
      );

      await ejecutar('up');
      const generados = await dataSource
        .getRepository(Employee)
        .count({ where: { distributorId: d.distributorId } });
      // 1 a mano + 2 choferes vigentes + 2 admins (Laura y el del escenario)
      expect(generados).toBe(5);
      expect(
        await dataSource
          .getRepository(Employee)
          .findOneByOrFail({ userId: admin.user.userId }),
      ).toMatchObject({ fileNumber: expect.any(String) as never });

      await ejecutar('down');

      const quedan = await dataSource.getRepository(Employee).find();
      expect(quedan.map((e) => e.firstName)).toEqual(['A mano']);
      // La secuencia vuelve al mayor legajo que queda (el 0001 cargado a mano).
      const secuencia = await dataSource
        .getRepository(DocumentSequence)
        .findOneByOrFail({
          distributorId: d.distributorId,
          docType: 'employee_file',
        });
      expect(secuencia.lastNumber).toBe(1);
    });
  });
});
