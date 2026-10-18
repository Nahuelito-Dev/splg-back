/**
 * Personal, tanda 2 (CU-183 a CU-185, CU-187 a CU-194, CU-246, CU-313 a CU-319)
 * contra la API con Postgres real: documentación del personal sobre las tareas
 * de flota, aviso diario, asistencia (panel y marcas del chofer), licencias con
 * su máquina de estados y la superposición bajo concurrencia, saldo de
 * vacaciones, tablero y la habilitación laboral del chofer en el despacho.
 * Firebase se simula: ningún test crea, deshabilita ni borra cuentas reales.
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
import { FirebaseAuthPort } from '../../src/firebase/ports/firebase-auth.port';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { Admin } from '../../src/admin/entities/admin.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Car } from '../../src/car/entities/car.entity';
import { VehicleAssignmentService } from '../../src/car/vehicle-assignment.service';
import {
  Employee,
  EmployeeStatus,
} from '../../src/employee/entities/employee.entity';
import {
  JobPosition,
  JobPositionCategory,
} from '../../src/employee/entities/job-position.entity';
import { JobPositionService } from '../../src/employee/job-position.service';
import {
  MaintenancePlan,
  MaintenanceSubject,
} from '../../src/fleet/entities/maintenance-plan.entity';
import { MaintenanceTask } from '../../src/fleet/entities/maintenance-task.entity';
import { FleetPlanSeedListener } from '../../src/fleet/fleet-plan-seed.listener';
import { FleetAlertsCron } from '../../src/fleet/fleet-alerts.cron';
import { FleetDispatchLockService } from '../../src/fleet/fleet-dispatch-lock.service';
import { DistribuidoraCreadaEvent } from '../../src/distributor/events/distribuidora-creada.event';
import { EmailSenderPort } from '../../src/email/ports/email-sender.port';
import { ScheduledTasksSettingsService } from '../../src/distributor/scheduled-tasks-settings.service';
import { AttendanceOpenAlertCron } from '../../src/attendance/attendance-open-alert.cron';
import { EmployeeAttendance } from '../../src/attendance/entities/employee-attendance.entity';
import { EmployeeLeave } from '../../src/leave/entities/employee-leave.entity';
import { diaArgentino, sumarDias } from '../../src/common/utils/dias-argentina';

type Cuerpo = Record<string, unknown>;
type Headers = Record<string, string>;

const DETALLE_CURSO = { certificateNumber: '123/26', issuer: 'CNRT' };
const DETALLE_ART = { insurer: 'Galeno ART', policyNumber: '99-1234' };

describe('Personal: documentación, asistencia, licencias y habilitación (e2e)', () => {
  let env: TestEnv;
  let dataSource: DataSource;
  let correos: Array<{ to: string; subject: string; html: string }>;

  beforeAll(async () => {
    env = await createTestApp();
    dataSource = env.app.get(DataSource);
    const firebase = env.app.get(FirebaseAuthPort);
    jest
      .spyOn(firebase, 'createUserSafe')
      .mockImplementation((datos) =>
        Promise.resolve({ uid: `uid-${datos.email}` } as never),
      );
    jest.spyOn(firebase, 'deleteUserSafe').mockResolvedValue(undefined);
    jest.spyOn(env.app.get(EmailSenderPort), 'send').mockImplementation((c) => {
      correos.push(c);
      return Promise.resolve();
    });
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
    correos = [];
    for (const tipo of ['admin', 'delivery', 'customer', 'super_admin']) {
      await rol(tipo);
    }
  });

  const http = () => request(env.app.getHttpServer());
  const cuerpoDe = <T = Cuerpo>(res: { body: unknown }) => res.body as T;

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
    await env.app
      .get(FleetPlanSeedListener)
      .handle(new DistribuidoraCreadaEvent(distribuidora.distributorId));
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

  async function planDe(distributorId: string, nombre: string) {
    return dataSource
      .getRepository(MaintenancePlan)
      .findOneOrFail({ where: { distributorId, name: nombre } });
  }

  let contador = 0;
  /** Un legajo sin cuenta de la categoría pedida. */
  async function legajo(
    headers: Headers,
    distributorId: string,
    categoria: JobPositionCategory,
    over: Cuerpo = {},
  ): Promise<string> {
    contador++;
    const puesto = await puestoDe(distributorId, categoria);
    const res = await http()
      .post('/employees')
      .set(headers)
      .send({
        positionId: puesto.positionId,
        firstName: 'Ana',
        lastName: `Pérez${contador}`,
        documentType: 'dni',
        documentNumber: `4000${String(contador).padStart(4, '0')}`,
        hireDate: '2024-03-01',
        employmentType: 'permanent',
        ...over,
      })
      .expect(201);
    return cuerpoDe<{ employeeId: string }>(res).employeeId;
  }

  /** Un chofer con cuenta (alta unificada: usuario + perfil de reparto + legajo). */
  async function chofer(headers: Headers) {
    const sufijo = randomUUID().slice(0, 8);
    const email = `chofer.${sufijo}@splg.local`;
    const res = await http()
      .post('/users')
      .set(headers)
      .send({
        email,
        password: 'Test1234',
        full_name: `Carlos Chofer${sufijo}`,
        phone_number: telefonoDePrueba(),
        rol: 'delivery',
      })
      .expect(201);
    const body = cuerpoDe<{ userId?: string; user_id?: string }>(res);
    const userId = (body.userId ?? body.user_id) as string;
    const empleado = await dataSource
      .getRepository(Employee)
      .findOneOrFail({ where: { userId } });
    const delivery = await dataSource
      .getRepository(Delivery)
      .findOneOrFail({ where: { userId } });
    const propios: Headers = {
      Authorization: `Bearer ${email}`,
      'X-Client-Source': 'driver-app',
    };
    return { userId, email, empleado, delivery, headers: propios };
  }

  async function ponerVehiculoEnUso(
    distributorId: string,
    userId: string,
    deliveryId: string,
  ) {
    const auto = (await dataSource.getRepository(Car).save({
      distributorId,
      userId,
      carPatent: `TST${randomUUID().slice(0, 6).toUpperCase()}`,
      carBrand: 'Fiat',
      carModel: 'Fiorino',
    } as Partial<Car>)) as Car;
    await env.app
      .get(VehicleAssignmentService)
      .ponerEnUso(deliveryId, auto.carId, null, distributorId, userId);
    return auto;
  }

  const cargarDocumento = (headers: Headers, over: Cuerpo): request.Test =>
    http().post('/fleet/tasks').set(headers).send(over);

  // ---------------------------------------------------------------------------

  describe('documentación del personal (CU-183, CU-184, CU-185)', () => {
    it('CU-183: registra el curso de mercancías peligrosas de un chofer y lo muestra con su estado y si bloquea', async () => {
      const { d1, admin1 } = await escenario();
      const empleadoId = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const curso = await planDe(
        d1.distributorId,
        'Curso de transporte de mercancías peligrosas (GLP)',
      );

      const res = await cargarDocumento(admin1.headers, {
        planId: curso.planId,
        employeeId: empleadoId,
        dueAt: '2099-05-10T15:00:00.000Z',
        details: DETALLE_CURSO,
      }).expect(201);

      expect(res.body).toMatchObject({
        employeeId: empleadoId,
        carId: null,
        deliveryId: null,
        details: DETALLE_CURSO,
        dueAt: '2099-05-10T00:00:00.000Z',
        expirationStatus: 'current',
        blocks: true,
      });
      const taskId = cuerpoDe<{ taskId: string }>(res).taskId;
      // Se puede corregir el detalle (validado contra el tipo del plan); el dueño no se cambia.
      await http()
        .patch(`/fleet/tasks/${taskId}`)
        .set(admin1.headers)
        .send({ details: { certificateNumber: '999/26', issuer: 'CNRT' } })
        .expect(200);
      await http()
        .patch(`/fleet/tasks/${taskId}`)
        .set(admin1.headers)
        .send({ details: { certificateNumber: '999/26' } })
        .expect(400);
      await http()
        .patch(`/fleet/tasks/${taskId}`)
        .set(admin1.headers)
        .send({ employeeId: randomUUID() })
        .expect(400);
      const ficha = await http()
        .get(`/employees/${empleadoId}/documents`)
        .set(admin1.headers)
        .expect(200);
      expect(ficha.body).toMatchObject({
        employeeId: empleadoId,
        isLocked: false,
        tasks: [{ details: { certificateNumber: '999/26', issuer: 'CNRT' } }],
      });
      const doc = cuerpoDe<{
        tasks: Array<{ plan: { name: string } }>;
        missingPlans: Array<{ name: string }>;
      }>(ficha);
      expect(doc.tasks.map((t) => t.plan.name)).toEqual([curso.name]);
      expect(doc.missingPlans.map((p) => p.name)).not.toContain(curso.name);
    });

    it('CU-184: registra el examen psicofísico con la fecha del examen', async () => {
      const { d1, admin1 } = await escenario();
      const empleadoId = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const plan = await planDe(d1.distributorId, 'Examen psicofísico');

      const res = await cargarDocumento(admin1.headers, {
        planId: plan.planId,
        employeeId: empleadoId,
        dueAt: '2099-01-31T00:00:00.000Z',
        details: { examDate: '2098-02-01' },
      }).expect(201);

      expect(res.body).toMatchObject({
        details: { examDate: '2098-02-01' },
        blocks: true,
      });
    });

    it('CU-185: la ART no bloquea y aplica a cualquier categoría', async () => {
      const { d1, admin1 } = await escenario();
      const empleadoId = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.WAREHOUSE,
      );
      const plan = await planDe(d1.distributorId, 'Alta en ART');

      const res = await cargarDocumento(admin1.headers, {
        planId: plan.planId,
        employeeId: empleadoId,
        dueAt: '2020-01-31T00:00:00.000Z',
        details: DETALLE_ART,
      }).expect(201);

      expect(res.body).toMatchObject({
        blocks: false,
        expirationStatus: 'expired',
      });
      // Vencida pero no bloqueante: no lo inhabilita.
      const ficha = await http()
        .get(`/employees/${empleadoId}/documents`)
        .set(admin1.headers)
        .expect(200);
      expect(ficha.body).toMatchObject({ isLocked: false });
    });

    it('excepciones del CUE: forma del detalle, plan o empleado ajenos, egresado y categoría que no aplica', async () => {
      const { d1, d2, admin1, admin2 } = await escenario();
      const chofer1 = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const deposito = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.WAREHOUSE,
      );
      const curso = await planDe(
        d1.distributorId,
        'Curso de transporte de mercancías peligrosas (GLP)',
      );
      const base = {
        planId: curso.planId,
        employeeId: chofer1,
        dueAt: '2099-05-10T00:00:00.000Z',
        details: DETALLE_CURSO,
      };

      // El detalle no tiene la forma del tipo: 400 e indica el campo.
      const sinEmisor = await cargarDocumento(admin1.headers, {
        ...base,
        details: { certificateNumber: '1' },
      }).expect(400);
      expect(JSON.stringify(sinEmisor.body)).toContain('detalle.issuer');
      await cargarDocumento(admin1.headers, {
        ...base,
        details: undefined,
      }).expect(400);
      // No aplica a la categoría del puesto: 400.
      await cargarDocumento(admin1.headers, {
        ...base,
        employeeId: deposito,
      }).expect(400);
      // Plan de otra distribuidora: 404. Empleado de otra distribuidora: 404.
      await cargarDocumento(admin2.headers, base).expect(404);
      const choferAjeno = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const cursoAjeno = await planDe(
        d2.distributorId,
        'Curso de transporte de mercancías peligrosas (GLP)',
      );
      await cargarDocumento(admin2.headers, {
        ...base,
        planId: cursoAjeno.planId,
        employeeId: choferAjeno,
      }).expect(404);
      // Egresado: 409.
      await http()
        .post(`/employees/${chofer1}/termination`)
        .set(admin1.headers)
        .send({ terminationDate: '2026-10-01', reason: 'resignation' })
        .expect(200);
      await cargarDocumento(admin1.headers, base).expect(409);

      expect(await dataSource.getRepository(MaintenanceTask).count()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------

  describe('vencimientos del personal (CU-187)', () => {
    it('el tablero agrupa por empleado, marca quién queda inhabilitado y filtra por categoría y distribuidora', async () => {
      const { d1, admin1, admin2 } = await escenario();
      const choferId = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const depositoId = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.WAREHOUSE,
      );
      const psico = await planDe(d1.distributorId, 'Examen psicofísico');
      const art = await planDe(d1.distributorId, 'Alta en ART');
      const enDias = (n: number) =>
        new Date(Date.now() + n * 86_400_000).toISOString();
      await cargarDocumento(admin1.headers, {
        planId: psico.planId,
        employeeId: choferId,
        dueAt: '2020-01-01T00:00:00.000Z',
        details: { examDate: '2019-01-01' },
      }).expect(201);
      await cargarDocumento(admin1.headers, {
        planId: art.planId,
        employeeId: depositoId,
        dueAt: enDias(10),
        details: DETALLE_ART,
      }).expect(201);
      // Fuera de la ventana de 30 días: no entra.
      await cargarDocumento(admin1.headers, {
        planId: art.planId,
        employeeId: choferId,
        dueAt: enDias(200),
        details: DETALLE_ART,
      }).expect(201);

      const res = await http()
        .get('/fleet/expirations?subject=employee&withinDays=30')
        .set(admin1.headers)
        .expect(200);
      const personal = cuerpoDe<{
        employees: Array<{
          employeeId: string;
          isLocked: boolean;
          category: string;
          items: Array<{ planName: string; expirationStatus: string }>;
        }>;
        vehicles: unknown[];
      }>(res);
      expect(personal.vehicles).toEqual([]);
      expect(personal.employees.map((e) => e.employeeId)).toEqual([
        choferId, // el más urgente primero
        depositoId,
      ]);
      expect(personal.employees[0]).toMatchObject({ isLocked: true });
      expect(personal.employees[0].items).toEqual([
        expect.objectContaining({
          planName: 'Examen psicofísico',
          expirationStatus: 'expired',
        }),
      ]);
      expect(personal.employees[1]).toMatchObject({ isLocked: false });

      const soloChoferes = await http()
        .get('/fleet/expirations?subject=employee&category=driver')
        .set(admin1.headers)
        .expect(200);
      expect(
        cuerpoDe<{ employees: Array<{ employeeId: string }> }>(
          soloChoferes,
        ).employees.map((e) => e.employeeId),
      ).toEqual([choferId]);

      const ajeno = await http()
        .get('/fleet/expirations?subject=employee')
        .set(admin2.headers)
        .expect(200);
      expect(cuerpoDe<{ employees: unknown[] }>(ajeno).employees).toEqual([]);
      await http()
        .get('/fleet/expirations?category=inexistente')
        .set(admin1.headers)
        .expect(400);
    });

    it('la ficha del empleado lista los planes que le faltan; la de otra distribuidora es 404', async () => {
      const { d1, admin1, admin2 } = await escenario();
      const choferId = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const depositoId = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.WAREHOUSE,
      );

      const chofer1 = await http()
        .get(`/employees/${choferId}/documents`)
        .set(admin1.headers)
        .expect(200);
      expect(
        cuerpoDe<{ missingPlans: Array<{ name: string }> }>(chofer1)
          .missingPlans.map((p) => p.name)
          .sort(),
      ).toEqual([
        'Alta en ART',
        'Curso de transporte de mercancías peligrosas (GLP)',
        'Examen psicofísico',
        'Licencia de conducir',
      ]);
      const deposito = await http()
        .get(`/employees/${depositoId}/documents`)
        .set(admin1.headers)
        .expect(200);
      expect(
        cuerpoDe<{ missingPlans: Array<{ name: string }> }>(
          deposito,
        ).missingPlans.map((p) => p.name),
      ).toEqual(['Alta en ART']);
      await http()
        .get(`/employees/${choferId}/documents`)
        .set(admin2.headers)
        .expect(404);
    });
  });

  describe('aviso diario del personal (CU-188)', () => {
    async function correrAviso() {
      jest
        .spyOn(
          env.app.get(ScheduledTasksSettingsService),
          'esLaHoraDelAvisoDeFlota',
        )
        .mockResolvedValue(true);
      await env.app.get(FleetAlertsCron).avisarVencimientosPendientes();
    }

    it('avisa una sola vez cada documento vencido, nombra al empleado y repite los faltantes cada día', async () => {
      const { d1, admin1 } = await escenario();
      const choferId = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.DRIVER,
        {
          firstName: 'Beto',
          lastName: 'Gómez',
        },
      );
      const psico = await planDe(d1.distributorId, 'Examen psicofísico');
      const tarea = cuerpoDe<{ taskId: string }>(
        await cargarDocumento(admin1.headers, {
          planId: psico.planId,
          employeeId: choferId,
          dueAt: '2020-01-01T00:00:00.000Z',
          details: { examDate: '2019-01-01' },
        }).expect(201),
      );

      await correrAviso();

      expect(correos).toHaveLength(1);
      expect(correos[0].to).toBe(admin1.user.email);
      expect(correos[0].html).toContain('Empleado Beto Gómez');
      expect(correos[0].html).toContain('Examen psicofísico');
      // Faltan el curso y la licencia (bloqueantes); la ART no es bloqueante: no figura.
      expect(correos[0].html).toContain(
        'Curso de transporte de mercancías peligrosas (GLP)',
      );
      expect(correos[0].html).not.toContain('Alta en ART');
      const marcada = await dataSource
        .getRepository(MaintenanceTask)
        .findOneByOrFail({ taskId: tarea.taskId });
      expect(marcada.alertedAt).toBeInstanceOf(Date);

      correos = [];
      await correrAviso();
      expect(correos).toHaveLength(1);
      expect(correos[0].html).not.toContain('Examen psicofísico —');
      expect(correos[0].html).toContain(
        'Curso de transporte de mercancías peligrosas (GLP)',
      );
    });

    it('si falla el envío no marca la tarea: se reintenta en el ciclo siguiente', async () => {
      const { d1, admin1 } = await escenario();
      const choferId = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const psico = await planDe(d1.distributorId, 'Examen psicofísico');
      const tarea = cuerpoDe<{ taskId: string }>(
        await cargarDocumento(admin1.headers, {
          planId: psico.planId,
          employeeId: choferId,
          dueAt: '2020-01-01T00:00:00.000Z',
          details: { examDate: '2019-01-01' },
        }).expect(201),
      );
      const envio = jest
        .spyOn(env.app.get(EmailSenderPort), 'send')
        .mockRejectedValueOnce(new Error('smtp caído'));

      await correrAviso();

      const sinMarcar = await dataSource
        .getRepository(MaintenanceTask)
        .findOneByOrFail({ taskId: tarea.taskId });
      expect(sinMarcar.alertedAt).toBeNull();
      envio.mockImplementation((c) => {
        correos.push(c);
        return Promise.resolve();
      });
      await correrAviso();
      expect(correos.length).toBeGreaterThan(0);
      expect(
        (
          await dataSource
            .getRepository(MaintenanceTask)
            .findOneByOrFail({ taskId: tarea.taskId })
        ).alertedAt,
      ).toBeInstanceOf(Date);
    });

    it('la licencia ya cargada en el perfil de reparto no figura como faltante', async () => {
      const { d1, admin1 } = await escenario();
      const c = await chofer(admin1.headers);
      const licencia = await planDe(d1.distributorId, 'Licencia de conducir');
      await cargarDocumento(admin1.headers, {
        planId: licencia.planId,
        deliveryId: c.delivery.deliveryId,
        dueAt: '2099-01-01T00:00:00.000Z',
      }).expect(201);

      const ficha = await http()
        .get(`/employees/${c.empleado.employeeId}/documents`)
        .set(admin1.headers)
        .expect(200);

      expect(
        cuerpoDe<{ missingPlans: Array<{ name: string }> }>(
          ficha,
        ).missingPlans.map((p) => p.name),
      ).not.toContain('Licencia de conducir');
      expect(cuerpoDe<{ tasks: unknown[] }>(ficha).tasks).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------

  describe('asistencia (CU-189, CU-313, CU-314)', () => {
    const registrar = (headers: Headers, id: string, cuerpo: Cuerpo) =>
      http().post(`/employees/${id}/attendance`).set(headers).send(cuerpo);

    it('CU-189: registra la jornada con el día argentino del ingreso y origen panel', async () => {
      const { d1, admin1 } = await escenario();
      const id = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.WAREHOUSE,
      );

      const res = await registrar(admin1.headers, id, {
        checkInAt: '2026-03-03T01:30:00.000Z', // 22:30 del día 2 en Argentina
        checkOutAt: '2026-03-03T09:30:00.000Z',
      }).expect(201);

      expect(res.body).toMatchObject({
        employeeId: id,
        workDate: '2026-03-02',
        source: 'panel',
        isOpen: false,
        durationMinutes: 480,
        recordedByUserId: admin1.user.userId,
      });
    });

    it('una sola jornada abierta por empleado, aunque dos administradores la carguen a la vez', async () => {
      const { d1, admin1 } = await escenario();
      const id = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.WAREHOUSE,
      );

      const respuestas = await Promise.all(
        [1, 2, 3].map((n) =>
          registrar(admin1.headers, id, {
            checkInAt: `2026-03-0${n}T11:00:00.000Z`,
          }),
        ),
      );

      const estados = respuestas.map((r) => r.status).sort();
      expect(estados).toEqual([201, 409, 409]);
      expect(
        await dataSource
          .getRepository(EmployeeAttendance)
          .count({ where: { employeeId: id } }),
      ).toBe(1);
    });

    it('excepciones: egreso no posterior, empleado ajeno o egresado, y contra otra distribuidora', async () => {
      const { d1, admin1, admin2 } = await escenario();
      const id = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.WAREHOUSE,
      );

      await registrar(admin1.headers, id, {
        checkInAt: '2026-03-02T11:00:00.000Z',
        checkOutAt: '2026-03-02T11:00:00.000Z',
      }).expect(400);
      await registrar(admin1.headers, id, { checkInAt: 'ayer' }).expect(400);
      await registrar(admin2.headers, id, {
        checkInAt: '2026-03-02T11:00:00.000Z',
      }).expect(404);
      await http()
        .post(`/employees/${id}/termination`)
        .set(admin1.headers)
        .send({ terminationDate: '2026-10-01', reason: 'resignation' })
        .expect(200);
      await registrar(admin1.headers, id, {
        checkInAt: '2026-03-02T11:00:00.000Z',
      }).expect(409);
      expect(await dataSource.getRepository(EmployeeAttendance).count()).toBe(
        0,
      );
    });

    it('CU-313: corrige con una nota obligatoria y el egreso sigue posterior al ingreso', async () => {
      const { d1, admin1, admin2 } = await escenario();
      const id = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.WAREHOUSE,
      );
      const creada = cuerpoDe<{ attendanceId: string }>(
        await registrar(admin1.headers, id, {
          checkInAt: '2026-03-02T11:00:00.000Z',
        }).expect(201),
      );
      const corregir = (headers: Headers, cuerpo: Cuerpo) =>
        http()
          .patch(`/attendance/${creada.attendanceId}`)
          .set(headers)
          .send(cuerpo);

      await corregir(admin1.headers, {
        checkOutAt: '2026-03-02T19:00:00.000Z',
      }).expect(400); // sin nota
      await corregir(admin1.headers, {
        checkOutAt: '2026-03-02T19:00:00.000Z',
        notes: '  ',
      }).expect(400);
      await corregir(admin1.headers, {
        checkOutAt: '2026-03-02T10:00:00.000Z',
        notes: 'x',
      }).expect(400);
      await corregir(admin1.headers, { notes: 'sin cambios' }).expect(400);
      await corregir(admin2.headers, {
        checkOutAt: '2026-03-02T19:00:00.000Z',
        notes: 'x',
      }).expect(404);

      const ok = await corregir(admin1.headers, {
        checkOutAt: '2026-03-02T19:00:00.000Z',
        notes: 'Olvidó marcar la salida',
      }).expect(200);
      expect(ok.body).toMatchObject({
        isOpen: false,
        durationMinutes: 480,
        notes: 'Olvidó marcar la salida',
      });
      // Una vez cerrada se puede volver a abrir otra: ya no hay jornada abierta.
      await registrar(admin1.headers, id, {
        checkInAt: '2026-03-03T11:00:00.000Z',
      }).expect(201);
    });

    it('CU-314: consulta por día, período, empleado y abiertas; cuenta presentes y rezagadas; aísla distribuidoras', async () => {
      const { d1, admin1, admin2 } = await escenario();
      const a = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.WAREHOUSE,
      );
      const b = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.SALES,
      );
      const hoy = diaArgentino();
      const ayer = sumarDias(hoy, -1);
      await registrar(admin1.headers, a, {
        checkInAt: `${ayer}T14:00:00.000Z`,
        checkOutAt: `${ayer}T20:00:00.000Z`,
      }).expect(201);
      await registrar(admin1.headers, a, {
        checkInAt: new Date().toISOString(),
      }).expect(201);
      await registrar(admin1.headers, b, {
        checkInAt: `${ayer}T15:00:00.000Z`,
      }).expect(201);

      const delDia = cuerpoDe<{
        total: number;
        presentToday: number;
        staleOpen: number;
        data: Array<{ employeeId: string }>;
      }>(await http().get('/attendance').set(admin1.headers).expect(200));
      expect(delDia).toMatchObject({ total: 1, presentToday: 1, staleOpen: 1 });
      expect(delDia.data[0].employeeId).toBe(a);

      const abiertas = cuerpoDe<{ total: number }>(
        await http()
          .get('/attendance?open=true')
          .set(admin1.headers)
          .expect(200),
      );
      expect(abiertas.total).toBe(2);
      const deB = cuerpoDe<{ total: number }>(
        await http()
          .get(`/attendance?employeeId=${b}&from=${ayer}&to=${hoy}`)
          .set(admin1.headers)
          .expect(200),
      );
      expect(deB.total).toBe(1);
      const porFecha = cuerpoDe<{ total: number }>(
        await http()
          .get(`/attendance?date=${ayer}`)
          .set(admin1.headers)
          .expect(200),
      );
      expect(porFecha.total).toBe(2);

      const ajeno = cuerpoDe<{ total: number; presentToday: number }>(
        await http()
          .get(`/attendance?date=${ayer}`)
          .set(admin2.headers)
          .expect(200),
      );
      expect(ajeno).toMatchObject({ total: 0, presentToday: 0 });
      await http()
        .get('/attendance?date=2026-13-45')
        .set(admin1.headers)
        .expect(400);
      await http()
        .get(`/attendance?from=${hoy}&to=${ayer}`)
        .set(admin1.headers)
        .expect(400);
      await http()
        .get('/attendance?open=quizas')
        .set(admin1.headers)
        .expect(400);
    });

    it('el aviso de las 7 informa las jornadas del día anterior sin cerrar y no las cierra', async () => {
      const { d1, admin1 } = await escenario();
      const a = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.WAREHOUSE,
        {
          firstName: 'Olvidadiza',
        },
      );
      const ayer = sumarDias(diaArgentino(), -1);
      await registrar(admin1.headers, a, {
        checkInAt: `${ayer}T14:00:00.000Z`,
      }).expect(201);

      await env.app.get(AttendanceOpenAlertCron).avisarJornadasSinCerrar();

      expect(correos).toHaveLength(1);
      expect(correos[0].html).toContain('Olvidadiza');
      expect(
        (
          await dataSource
            .getRepository(EmployeeAttendance)
            .findOneByOrFail({ employeeId: a })
        ).checkOutAt,
      ).toBeNull();
    });
  });

  describe('marcas del chofer (CU-190, CU-315)', () => {
    it('inicia y finaliza su jornada con origen app; no hay segunda abierta ni cierre sin abrir', async () => {
      const { admin1 } = await escenario();
      const c = await chofer(admin1.headers);

      await http()
        .post('/attendance/mine/check-out')
        .set(c.headers)
        .expect(409);
      const inicio = await http()
        .post('/attendance/mine/check-in')
        .set(c.headers)
        .expect(201);
      expect(inicio.body).toMatchObject({
        employeeId: c.empleado.employeeId,
        source: 'driver_app',
        isOpen: true,
        recordedByUserId: c.userId,
      });
      // Idempotente: la segunda marca devuelve la misma jornada abierta (200).
      const repetida = await http()
        .post('/attendance/mine/check-in')
        .set(c.headers)
        .expect(200);
      expect(repetida.body).toMatchObject({
        attendanceId: (inicio.body as { attendanceId: string }).attendanceId,
      });
      const fin = await http()
        .post('/attendance/mine/check-out')
        .set(c.headers)
        .expect(200);
      expect(fin.body).toMatchObject({ isOpen: false });
      await http()
        .post('/attendance/mine/check-out')
        .set(c.headers)
        .expect(409);

      // La jornada del chofer aparece en la grilla del administrador.
      const grilla = await http()
        .get('/attendance')
        .set(admin1.headers)
        .expect(200);
      expect(cuerpoDe<{ total: number }>(grilla).total).toBe(1);
    });

    it('dos inicios a la vez: uno gana y el otro es conflicto', async () => {
      const { admin1 } = await escenario();
      const c = await chofer(admin1.headers);

      const respuestas = await Promise.all([
        http().post('/attendance/mine/check-in').set(c.headers),
        http().post('/attendance/mine/check-in').set(c.headers),
      ]);

      expect(respuestas.map((r) => r.status).sort()).toEqual([200, 201]);
    });

    it('una jornada abierta de un día anterior no se cierra desde la app (409) y el inicio tampoco se repite', async () => {
      const { admin1 } = await escenario();
      const c = await chofer(admin1.headers);
      const ayer = sumarDias(diaArgentino(), -1);
      await http()
        .post(`/employees/${c.empleado.employeeId}/attendance`)
        .set(admin1.headers)
        .send({ checkInAt: `${ayer}T14:00:00.000Z` })
        .expect(201);
      await http()
        .post('/attendance/mine/check-out')
        .set(c.headers)
        .expect(409);
      await http().post('/attendance/mine/check-in').set(c.headers).expect(409);
    });

    it('un chofer sin legajo o con el legajo egresado no puede marcar (409); el administrador no tiene estas rutas (403)', async () => {
      const { d1, admin1 } = await escenario();
      const sufijo = randomUUID().slice(0, 8);
      const sinLegajo = await dataSource.getRepository(User).save({
        email: `solo.${sufijo}@splg.local`,
        fullName: 'Sin legajo',
        phoneNumber: telefonoDePrueba(),
        roleId: (await rol('delivery')).roleId,
      } as Partial<User>);
      await dataSource.getRepository(Delivery).save({
        distributorId: d1.distributorId,
        userId: sinLegajo.userId,
      } as Partial<Delivery>);
      const headersSinLegajo: Headers = {
        Authorization: `Bearer solo.${sufijo}@splg.local`,
        'X-Client-Source': 'driver-app',
      };
      await http()
        .post('/attendance/mine/check-in')
        .set(headersSinLegajo)
        .expect(409);

      const c = await chofer(admin1.headers);
      await dataSource.getRepository(Employee).update(
        { employeeId: c.empleado.employeeId },
        {
          status: EmployeeStatus.TERMINATED,
          terminationDate: diaArgentino(),
        },
      );
      await http().post('/attendance/mine/check-in').set(c.headers).expect(409);

      await http()
        .post('/attendance/mine/check-in')
        .set(admin1.headers)
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------

  describe('licencias y ausencias (CU-191, CU-316 a CU-319)', () => {
    const cargar = (headers: Headers, id: string, over: Cuerpo = {}) =>
      http()
        .post(`/employees/${id}/leaves`)
        .set(headers)
        .send({
          type: 'vacation',
          startDate: '2099-12-01',
          endDate: '2099-12-14',
          reason: 'Vacaciones',
          ...over,
        });
    const idDe = (res: { body: unknown }) =>
      cuerpoDe<{ leaveId: string }>(res).leaveId;

    it('CU-191: nace solicitada, con los días corridos y quién la cargó', async () => {
      const { d1, admin1 } = await escenario();
      const id = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.SALES,
      );

      const res = await cargar(admin1.headers, id).expect(201);

      expect(res.body).toMatchObject({
        employeeId: id,
        type: 'vacation',
        days: 14,
        status: 'requested',
        requestedByUserId: admin1.user.userId,
        decidedByUserId: null,
        decidedAt: null,
      });
    });

    it('no admite superposición con otra solicitada o aprobada e indica cuál; las rechazadas y canceladas liberan el período', async () => {
      const { d1, admin1 } = await escenario();
      const id = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.SALES,
      );
      const primera = idDe(await cargar(admin1.headers, id).expect(201));

      const choque = await cargar(admin1.headers, id, {
        startDate: '2099-12-14',
        endDate: '2099-12-20',
      }).expect(409);
      expect(JSON.stringify(choque.body)).toContain(primera);
      // Contigua (un día después): no se pisa.
      await cargar(admin1.headers, id, {
        startDate: '2099-12-15',
        endDate: '2099-12-16',
      }).expect(201);

      await http()
        .patch(`/leaves/${primera}/reject`)
        .set(admin1.headers)
        .send({ reason: 'No hay cobertura' })
        .expect(200);
      await cargar(admin1.headers, id, {
        startDate: '2099-12-10',
        endDate: '2099-12-12',
      }).expect(201);
      const otra = idDe(
        await cargar(admin1.headers, id, {
          startDate: '2099-11-01',
          endDate: '2099-11-03',
        }).expect(201),
      );
      await http()
        .patch(`/leaves/${otra}/cancel`)
        .set(admin1.headers)
        .expect(200);
      await cargar(admin1.headers, id, {
        startDate: '2099-11-02',
        endDate: '2099-11-02',
      }).expect(201);
    });

    it('dos administradores cargando el mismo período a la vez: una sola queda', async () => {
      const { d1, admin1 } = await escenario();
      const segundo = await seedAdmin(d1.distributorId);
      const id = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.SALES,
      );

      const respuestas = await Promise.all([
        cargar(admin1.headers, id),
        cargar(segundo.headers, id),
        cargar(admin1.headers, id, {
          startDate: '2099-12-05',
          endDate: '2099-12-06',
        }),
      ]);

      expect(respuestas.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(
        await dataSource
          .getRepository(EmployeeLeave)
          .count({ where: { employeeId: id } }),
      ).toBe(1);
    });

    it('excepciones de alta: fin anterior al inicio, egresado, empleado o fechas inválidas, otra distribuidora', async () => {
      const { d1, admin1, admin2 } = await escenario();
      const id = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.SALES,
      );

      await cargar(admin1.headers, id, {
        startDate: '2099-12-10',
        endDate: '2099-12-01',
      }).expect(400);
      await cargar(admin1.headers, id, { startDate: '2099-02-30' }).expect(400);
      await cargar(admin1.headers, id, { type: 'feriado' }).expect(400);
      await cargar(admin2.headers, id).expect(404);
      await http()
        .post(`/employees/${id}/termination`)
        .set(admin1.headers)
        .send({ terminationDate: '2026-10-01', reason: 'resignation' })
        .expect(200);
      await cargar(admin1.headers, id).expect(409);
      expect(await dataSource.getRepository(EmployeeLeave).count()).toBe(0);
    });

    it('CU-316: sólo se modifica una solicitada, con control de superposición y recálculo de días', async () => {
      const { d1, admin1, admin2 } = await escenario();
      const id = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.SALES,
      );
      const l1 = idDe(await cargar(admin1.headers, id).expect(201));
      const l2 = idDe(
        await cargar(admin1.headers, id, {
          startDate: '2099-12-20',
          endDate: '2099-12-22',
        }).expect(201),
      );

      const ok = await http()
        .patch(`/leaves/${l1}`)
        .set(admin1.headers)
        .send({ endDate: '2099-12-18', reason: 'Se acorta' })
        .expect(200);
      expect(ok.body).toMatchObject({
        days: 18,
        endDate: '2099-12-18',
        reason: 'Se acorta',
        status: 'requested',
      });
      // Se pisa con l2 → 409; fin < inicio → 400; no cuenta contra sí misma.
      await http()
        .patch(`/leaves/${l1}`)
        .set(admin1.headers)
        .send({ endDate: '2099-12-21' })
        .expect(409);
      await http()
        .patch(`/leaves/${l1}`)
        .set(admin1.headers)
        .send({ startDate: '2099-12-30' })
        .expect(400);
      await http()
        .patch(`/leaves/${l1}`)
        .set(admin1.headers)
        .send({ type: 'sick' })
        .expect(200);
      await http()
        .patch(`/leaves/${l1}`)
        .set(admin2.headers)
        .send({ type: 'study' })
        .expect(404);

      await http()
        .patch(`/leaves/${l2}/approve`)
        .set(admin1.headers)
        .expect(200);
      await http()
        .patch(`/leaves/${l2}`)
        .set(admin1.headers)
        .send({ reason: 'tarde' })
        .expect(409);
    });

    it('CU-192 y CU-318: aprobar asienta autor y fecha; rechazar exige motivo; sólo desde solicitada', async () => {
      const { d1, admin1, admin2 } = await escenario();
      const id = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.SALES,
      );
      const aprobar = idDe(await cargar(admin1.headers, id).expect(201));
      const rechazar = idDe(
        await cargar(admin1.headers, id, {
          startDate: '2099-11-01',
          endDate: '2099-11-02',
        }).expect(201),
      );

      await http()
        .patch(`/leaves/${aprobar}/approve`)
        .set(admin2.headers)
        .expect(404);
      const aprobada = await http()
        .patch(`/leaves/${aprobar}/approve`)
        .set(admin1.headers)
        .expect(200);
      expect(aprobada.body).toMatchObject({
        status: 'approved',
        decidedByUserId: admin1.user.userId,
      });
      expect((aprobada.body as { decidedAt: string }).decidedAt).toEqual(
        expect.any(String),
      );
      await http()
        .patch(`/leaves/${aprobar}/approve`)
        .set(admin1.headers)
        .expect(409);
      await http()
        .patch(`/leaves/${aprobar}/reject`)
        .set(admin1.headers)
        .send({ reason: 'tarde' })
        .expect(409);

      await http()
        .patch(`/leaves/${rechazar}/reject`)
        .set(admin1.headers)
        .send({})
        .expect(400);
      await http()
        .patch(`/leaves/${rechazar}/reject`)
        .set(admin1.headers)
        .send({ reason: '   ' })
        .expect(400);
      await http()
        .patch(`/leaves/${rechazar}/reject`)
        .set(admin2.headers)
        .send({ reason: 'x' })
        .expect(404);
      const rechazada = await http()
        .patch(`/leaves/${rechazar}/reject`)
        .set(admin1.headers)
        .send({ reason: 'Sin cobertura' })
        .expect(200);
      expect(rechazada.body).toMatchObject({
        status: 'rejected',
        rejectionReason: 'Sin cobertura',
        decidedByUserId: admin1.user.userId,
      });
      await http()
        .patch(`/leaves/${rechazar}/approve`)
        .set(admin1.headers)
        .expect(409);
    });

    it('CU-317: cancela una aprobada que no terminó; una terminada, rechazada o cancelada es conflicto', async () => {
      const { d1, admin1, admin2 } = await escenario();
      const id = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.SALES,
      );
      const futura = idDe(await cargar(admin1.headers, id).expect(201));
      await http()
        .patch(`/leaves/${futura}/approve`)
        .set(admin1.headers)
        .expect(200);
      await http()
        .patch(`/leaves/${futura}/cancel`)
        .set(admin2.headers)
        .expect(404);
      const cancelada = await http()
        .patch(`/leaves/${futura}/cancel`)
        .set(admin1.headers)
        .expect(200);
      expect(cancelada.body).toMatchObject({ status: 'cancelled' });
      await http()
        .patch(`/leaves/${futura}/cancel`)
        .set(admin1.headers)
        .expect(409);

      const pasada = idDe(
        await cargar(admin1.headers, id, {
          startDate: '2024-01-10',
          endDate: '2024-01-12',
        }).expect(201),
      );
      await http()
        .patch(`/leaves/${pasada}/approve`)
        .set(admin1.headers)
        .expect(200);
      const terminada = await http()
        .patch(`/leaves/${pasada}/cancel`)
        .set(admin1.headers)
        .expect(409);
      expect(JSON.stringify(terminada.body)).toContain('ya terminó');
    });

    it('CU-319: bandeja y consulta por estado, tipo, empleado y período, solo de la propia distribuidora', async () => {
      const { d1, admin1, admin2 } = await escenario();
      const a = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.SALES,
      );
      const b = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.WAREHOUSE,
      );
      await cargar(admin1.headers, a).expect(201);
      const enfermedad = idDe(
        await cargar(admin1.headers, b, {
          type: 'sick',
          startDate: '2099-06-01',
          endDate: '2099-06-03',
        }).expect(201),
      );
      await http()
        .patch(`/leaves/${enfermedad}/approve`)
        .set(admin1.headers)
        .expect(200);

      const lista = async (consulta: string, headers = admin1.headers) =>
        cuerpoDe<{
          total: number;
          data: Array<{ employeeName: string; leaveId: string }>;
        }>(await http().get(`/leaves${consulta}`).set(headers).expect(200));
      expect((await lista('')).total).toBe(2);
      expect((await lista('?status=requested')).total).toBe(1);
      expect((await lista('?type=sick')).data.map((l) => l.leaveId)).toEqual([
        enfermedad,
      ]);
      expect((await lista(`?employeeId=${a}`)).total).toBe(1);
      expect(
        (await lista('?from=2099-06-02&to=2099-06-02')).data.map(
          (l) => l.leaveId,
        ),
      ).toEqual([enfermedad]);
      expect((await lista('?from=2099-07-01&to=2099-11-30')).total).toBe(0);
      expect((await lista('?status=requested')).data[0].employeeName).toContain(
        'Pérez',
      );
      expect((await lista('', admin2.headers)).total).toBe(0);
      await http()
        .get('/leaves?status=lo-que-sea')
        .set(admin1.headers)
        .expect(400);
      await http()
        .get('/leaves?from=2099-12-31&to=2099-01-01')
        .set(admin1.headers)
        .expect(400);
      await http().get('/leaves?from=hoy').set(admin1.headers).expect(400);
    });

    it('CU-193: el saldo es lo que corresponde por antigüedad menos las vacaciones aprobadas del año', async () => {
      const { d1, admin1, admin2 } = await escenario();
      const id = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.SALES,
        {
          hireDate: '2020-01-01',
        },
      );
      const vacaciones = idDe(
        await cargar(admin1.headers, id, {
          startDate: '2099-03-01',
          endDate: '2099-03-10',
        }).expect(201),
      );
      const sinAprobar = idDe(
        await cargar(admin1.headers, id, {
          startDate: '2099-04-01',
          endDate: '2099-04-05',
        }).expect(201),
      );
      const enfermedad = idDe(
        await cargar(admin1.headers, id, {
          type: 'sick',
          startDate: '2099-05-01',
          endDate: '2099-05-03',
        }).expect(201),
      );
      await http()
        .patch(`/leaves/${vacaciones}/approve`)
        .set(admin1.headers)
        .expect(200);
      await http()
        .patch(`/leaves/${enfermedad}/approve`)
        .set(admin1.headers)
        .expect(200);
      expect(sinAprobar).toBeDefined();

      const res = await http()
        .get(`/employees/${id}/vacation-balance?year=2099`)
        .set(admin1.headers)
        .expect(200);
      expect(res.body).toEqual({
        employeeId: id,
        year: 2099,
        entitledDays: 35, // 79 años de antigüedad
        takenDays: 10,
        balanceDays: 25,
      });
      const actual = await http()
        .get(`/employees/${id}/vacation-balance`)
        .set(admin1.headers)
        .expect(200);
      expect(actual.body).toMatchObject({
        year: Number(diaArgentino().slice(0, 4)),
        entitledDays: 21,
      });
      await http()
        .get(`/employees/${id}/vacation-balance?year=1800`)
        .set(admin1.headers)
        .expect(400);
      await http()
        .get(`/employees/${id}/vacation-balance?year=abc`)
        .set(admin1.headers)
        .expect(400);
      await http()
        .get(`/employees/${id}/vacation-balance`)
        .set(admin2.headers)
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------

  describe('tablero de personal (CU-194)', () => {
    it('sin empleados muestra todo en cero', async () => {
      const { admin1 } = await escenario();
      const res = await http()
        .get('/personnel/dashboard')
        .set(admin1.headers)
        .expect(200);
      expect(res.body).toMatchObject({
        today: diaArgentino(),
        totalActive: 0,
        activeByPosition: [],
        presentToday: 0,
        onLeaveToday: 0,
        documents: { current: 0, dueSoon: 0, expired: 0 },
      });
    });

    it('cuenta activos por puesto, presentes, de licencia hoy y documentos por estado, sólo de la propia distribuidora', async () => {
      const { d1, admin1, admin2 } = await escenario();
      const choferA = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const choferB = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const deposito = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.WAREHOUSE,
      );
      const egresado = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.SALES,
      );
      await http()
        .post(`/employees/${egresado}/termination`)
        .set(admin1.headers)
        .send({ terminationDate: '2026-10-01', reason: 'resignation' })
        .expect(200);
      // Presentes: A con jornada abierta; B con jornada cerrada (no cuenta).
      await http()
        .post(`/employees/${choferA}/attendance`)
        .set(admin1.headers)
        .send({ checkInAt: new Date().toISOString() })
        .expect(201);
      await http()
        .post(`/employees/${choferB}/attendance`)
        .set(admin1.headers)
        .send({
          checkInAt: '2026-03-02T11:00:00.000Z',
          checkOutAt: '2026-03-02T19:00:00.000Z',
        })
        .expect(201);
      // De licencia hoy: el depósito con una aprobada que cubre hoy; otra aprobada futura no cuenta; una solicitada tampoco.
      const hoy = diaArgentino();
      const deHoy = cuerpoDe<{ leaveId: string }>(
        await http()
          .post(`/employees/${deposito}/leaves`)
          .set(admin1.headers)
          .send({
            type: 'sick',
            startDate: sumarDias(hoy, -1),
            endDate: sumarDias(hoy, 1),
          })
          .expect(201),
      );
      await http()
        .patch(`/leaves/${deHoy.leaveId}/approve`)
        .set(admin1.headers)
        .expect(200);
      const futura = cuerpoDe<{ leaveId: string }>(
        await http()
          .post(`/employees/${choferB}/leaves`)
          .set(admin1.headers)
          .send({
            type: 'vacation',
            startDate: sumarDias(hoy, 10),
            endDate: sumarDias(hoy, 12),
          })
          .expect(201),
      );
      await http()
        .patch(`/leaves/${futura.leaveId}/approve`)
        .set(admin1.headers)
        .expect(200);
      await http()
        .post(`/employees/${choferA}/leaves`)
        .set(admin1.headers)
        .send({ type: 'study', startDate: hoy, endDate: hoy })
        .expect(201);
      // Documentos: uno vencido (psicofísico de A), uno por vencer (ART del depósito), uno vigente (ART de B).
      const psico = await planDe(d1.distributorId, 'Examen psicofísico');
      const art = await planDe(d1.distributorId, 'Alta en ART');
      const enDias = (n: number) =>
        new Date(Date.now() + n * 86_400_000).toISOString();
      await cargarDocumento(admin1.headers, {
        planId: psico.planId,
        employeeId: choferA,
        dueAt: '2020-01-01T00:00:00.000Z',
        details: { examDate: '2019-01-01' },
      }).expect(201);
      await cargarDocumento(admin1.headers, {
        planId: art.planId,
        employeeId: deposito,
        dueAt: enDias(5),
        details: DETALLE_ART,
      }).expect(201);
      await cargarDocumento(admin1.headers, {
        planId: art.planId,
        employeeId: choferB,
        dueAt: enDias(300),
        details: DETALLE_ART,
      }).expect(201);

      const res = await http()
        .get('/personnel/dashboard')
        .set(admin1.headers)
        .expect(200);

      expect(res.body).toMatchObject({
        totalActive: 3,
        presentToday: 1,
        onLeaveToday: 1,
        documents: { current: 1, dueSoon: 1, expired: 1 },
      });
      expect(
        cuerpoDe<{ activeByPosition: Array<{ name: string; count: number }> }>(
          res,
        ).activeByPosition,
      ).toEqual([
        expect.objectContaining({ name: 'Chofer', count: 2 }),
        expect.objectContaining({ name: 'Depósito', count: 1 }),
      ]);

      const ajeno = await http()
        .get('/personnel/dashboard')
        .set(admin2.headers)
        .expect(200);
      expect(ajeno.body).toMatchObject({
        totalActive: 0,
        presentToday: 0,
        onLeaveToday: 0,
      });
    });
  });

  // ---------------------------------------------------------------------------

  describe('habilitación laboral del chofer en el despacho (CU-246)', () => {
    let gate: FleetDispatchLockService;
    beforeAll(() => {
      gate = env.app.get(FleetDispatchLockService);
    });

    async function choferEnCondiciones(
      headers: Headers,
      distributorId: string,
    ) {
      const c = await chofer(headers);
      await ponerVehiculoEnUso(distributorId, c.userId, c.delivery.deliveryId);
      return c;
    }

    it('un chofer en condiciones está habilitado; sin legajo conserva el comportamiento vigente', async () => {
      const { d1, admin1 } = await escenario();
      const c = await choferEnCondiciones(admin1.headers, d1.distributorId);
      await expect(
        gate.motivosDeInhabilitacion(c.userId, d1.distributorId),
      ).resolves.toEqual([]);

      await dataSource
        .getRepository(Employee)
        .update({ employeeId: c.empleado.employeeId }, { userId: null });
      await expect(
        gate.motivosDeInhabilitacion(c.userId, d1.distributorId),
      ).resolves.toEqual([]);
    });

    it('una licencia aprobada que cubre hoy lo inhabilita; cancelarla, o que sea de otro día, lo habilita', async () => {
      const { d1, admin1 } = await escenario();
      const c = await choferEnCondiciones(admin1.headers, d1.distributorId);
      const hoy = diaArgentino();
      const licencia = cuerpoDe<{ leaveId: string }>(
        await http()
          .post(`/employees/${c.empleado.employeeId}/leaves`)
          .set(admin1.headers)
          .send({ type: 'sick', startDate: hoy, endDate: sumarDias(hoy, 2) })
          .expect(201),
      ).leaveId;

      // Solicitada todavía no inhabilita.
      await expect(
        gate.choferesInhabilitados([c.userId], d1.distributorId),
      ).resolves.toEqual(new Set());
      await http()
        .patch(`/leaves/${licencia}/approve`)
        .set(admin1.headers)
        .expect(200);
      await expect(
        gate.motivosDeInhabilitacion(c.userId, d1.distributorId),
      ).resolves.toEqual([
        'tiene una licencia aprobada que cubre el día de hoy',
      ]);
      await expect(
        gate.assertChoferHabilitado(c.userId, d1.distributorId),
      ).rejects.toThrow(/licencia aprobada/);

      await http()
        .patch(`/leaves/${licencia}/cancel`)
        .set(admin1.headers)
        .expect(200);
      await expect(
        gate.choferesInhabilitados([c.userId], d1.distributorId),
      ).resolves.toEqual(new Set());

      const manana = sumarDias(hoy, 1);
      const futura = cuerpoDe<{ leaveId: string }>(
        await http()
          .post(`/employees/${c.empleado.employeeId}/leaves`)
          .set(admin1.headers)
          .send({ type: 'vacation', startDate: manana, endDate: manana })
          .expect(201),
      ).leaveId;
      await http()
        .patch(`/leaves/${futura}/approve`)
        .set(admin1.headers)
        .expect(200);
      await expect(
        gate.choferesInhabilitados([c.userId], d1.distributorId),
      ).resolves.toEqual(new Set());
    });

    it('una tarea bloqueante vencida de su legajo lo inhabilita; renovarla (cerrar y cargar otra) lo habilita', async () => {
      const { d1, admin1 } = await escenario();
      const c = await choferEnCondiciones(admin1.headers, d1.distributorId);
      const curso = await planDe(
        d1.distributorId,
        'Curso de transporte de mercancías peligrosas (GLP)',
      );
      const vencida = cuerpoDe<{ taskId: string }>(
        await cargarDocumento(admin1.headers, {
          planId: curso.planId,
          employeeId: c.empleado.employeeId,
          dueAt: '2020-06-30T00:00:00.000Z',
          details: DETALLE_CURSO,
        }).expect(201),
      );

      await expect(
        gate.motivosDeInhabilitacion(c.userId, d1.distributorId),
      ).resolves.toEqual([`${curso.name}: venció el 30/06/2020`]);

      await http()
        .patch(`/fleet/tasks/${vencida.taskId}/close`)
        .set(admin1.headers)
        .send({ performedAt: '2026-10-01T00:00:00.000Z' })
        .expect(200);
      await cargarDocumento(admin1.headers, {
        planId: curso.planId,
        employeeId: c.empleado.employeeId,
        dueAt: '2099-06-30T00:00:00.000Z',
        details: DETALLE_CURSO,
      }).expect(201);
      await expect(
        gate.choferesInhabilitados([c.userId], d1.distributorId),
      ).resolves.toEqual(new Set());
    });

    it('un legajo egresado lo inhabilita', async () => {
      const { d1, admin1 } = await escenario();
      const c = await choferEnCondiciones(admin1.headers, d1.distributorId);
      await dataSource.getRepository(Employee).update(
        { employeeId: c.empleado.employeeId },
        {
          status: EmployeeStatus.TERMINATED,
          terminationDate: diaArgentino(),
        },
      );
      await expect(
        gate.motivosDeInhabilitacion(c.userId, d1.distributorId),
      ).resolves.toEqual(['su legajo está egresado']);
    });

    it('lo de un legajo de otra distribuidora no cuenta para este chofer', async () => {
      const { d1, d2, admin1, admin2 } = await escenario();
      const c = await choferEnCondiciones(admin1.headers, d1.distributorId);
      const deposito = await legajo(
        admin2.headers,
        d2.distributorId,
        JobPositionCategory.DRIVER,
      );
      const psico = await planDe(d2.distributorId, 'Examen psicofísico');
      await cargarDocumento(admin2.headers, {
        planId: psico.planId,
        employeeId: deposito,
        dueAt: '2020-01-01T00:00:00.000Z',
        details: { examDate: '2019-01-01' },
      }).expect(201);

      await expect(
        gate.choferesInhabilitados([c.userId], d1.distributorId),
      ).resolves.toEqual(new Set());
    });

    it('resuelve cincuenta candidatos en lote y señala exactamente a los inhabilitados', async () => {
      const { d1 } = await escenario();
      const puesto = await puestoDe(
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      const rolDelivery = await rol('delivery');
      const hoy = diaArgentino();
      const curso = await planDe(
        d1.distributorId,
        'Curso de transporte de mercancías peligrosas (GLP)',
      );
      const esperados = new Set<string>();
      const ids: string[] = [];

      for (let i = 0; i < 50; i++) {
        const user = (await dataSource.getRepository(User).save({
          email: `lote${i}.${randomUUID().slice(0, 6)}@splg.local`,
          fullName: `Lote ${i}`,
          phoneNumber: telefonoDePrueba(),
          roleId: rolDelivery.roleId,
        } as Partial<User>)) as User;
        const delivery = (await dataSource.getRepository(Delivery).save({
          distributorId: d1.distributorId,
          userId: user.userId,
        } as Partial<Delivery>)) as Delivery;
        const empleado = await dataSource.getRepository(Employee).save({
          distributorId: d1.distributorId,
          userId: user.userId,
          positionId: puesto.positionId,
          fileNumber: `L${String(i).padStart(4, '0')}`,
          firstName: 'Lote',
          lastName: `${i}`,
          documentType: 'dni',
          documentNumber: `9${String(i).padStart(7, '0')}`,
          hireDate: '2024-01-01',
          employmentType: 'permanent',
          status: EmployeeStatus.ACTIVE,
        } as unknown as Partial<Employee>);
        await ponerVehiculoEnUso(
          d1.distributorId,
          user.userId,
          delivery.deliveryId,
        );
        ids.push(user.userId);
        if (i % 5 === 0) {
          // Cada quinto, con una licencia aprobada que cubre hoy.
          await dataSource.getRepository(EmployeeLeave).save({
            distributorId: d1.distributorId,
            employeeId: empleado.employeeId,
            type: 'sick',
            startDate: hoy,
            endDate: hoy,
            days: 1,
            status: 'approved',
          } as unknown as Partial<EmployeeLeave>);
          esperados.add(user.userId);
        } else if (i % 7 === 0) {
          // Cada séptimo (que no sea quinto), con el curso vencido.
          await dataSource.getRepository(MaintenanceTask).save({
            planId: curso.planId,
            distributorId: d1.distributorId,
            employeeId: empleado.employeeId,
            status: 'scheduled',
            dueAt: new Date('2020-01-01T00:00:00Z'),
            details: DETALLE_CURSO,
          } as unknown as Partial<MaintenanceTask>);
          esperados.add(user.userId);
        }
      }

      const inhabilitados = await gate.choferesInhabilitados(
        ids,
        d1.distributorId,
      );

      expect(inhabilitados).toEqual(esperados);
      expect(esperados.size).toBeGreaterThan(10);
    }, 120000);
  });

  // ---------------------------------------------------------------------------

  describe('integración con el legajo', () => {
    it('un legajo con documentación, jornadas o licencias no es un alta errónea: no se elimina (409)', async () => {
      const { d1, admin1 } = await escenario();
      const conJornada = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.SALES,
      );
      const conLicencia = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.SALES,
      );
      const conDocumento = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.SALES,
      );
      const limpio = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.SALES,
      );
      await http()
        .post(`/employees/${conJornada}/attendance`)
        .set(admin1.headers)
        .send({ checkInAt: '2026-03-02T11:00:00.000Z' })
        .expect(201);
      await http()
        .post(`/employees/${conLicencia}/leaves`)
        .set(admin1.headers)
        .send({ type: 'sick', startDate: '2099-01-01', endDate: '2099-01-02' })
        .expect(201);
      const art = await planDe(d1.distributorId, 'Alta en ART');
      await cargarDocumento(admin1.headers, {
        planId: art.planId,
        employeeId: conDocumento,
        dueAt: '2099-01-01T00:00:00.000Z',
        details: DETALLE_ART,
      }).expect(201);

      for (const id of [conJornada, conLicencia, conDocumento]) {
        await http().delete(`/employees/${id}`).set(admin1.headers).expect(409);
      }
      await http()
        .delete(`/employees/${limpio}`)
        .set(admin1.headers)
        .expect(200);
    });

    it('el rol de chofer no accede a las rutas del administrador', async () => {
      const { admin1 } = await escenario();
      const c = await chofer(admin1.headers);
      await http().get('/leaves').set(c.headers).expect(403);
      await http().get('/attendance').set(c.headers).expect(403);
      await http().get('/personnel/dashboard').set(c.headers).expect(403);
      await http()
        .get(`/employees/${c.empleado.employeeId}/documents`)
        .set(c.headers)
        .expect(403);
    });

    it('los planes base de personal se siembran con la distribuidora y se pueden desactivar', async () => {
      const { d1, admin1 } = await escenario();
      const planes = await http()
        .get('/fleet/plans?subject=employee')
        .set(admin1.headers)
        .expect(200);
      expect(
        cuerpoDe<
          Array<{
            name: string;
            documentKind: string;
            appliesToCategories: string[] | null;
          }>
        >(planes)
          .map((p) => [p.name, p.documentKind, p.appliesToCategories])
          .sort(),
      ).toEqual(
        [
          ['Alta en ART', 'art_coverage', null],
          [
            'Curso de transporte de mercancías peligrosas (GLP)',
            'hazmat_driver_course',
            ['driver'],
          ],
          ['Examen psicofísico', 'psychophysical', ['driver']],
        ].sort(),
      );
      const psico = await planDe(d1.distributorId, 'Examen psicofísico');
      await http()
        .patch(`/fleet/plans/${psico.planId}`)
        .set(admin1.headers)
        .send({ isActive: false })
        .expect(200);
      expect(
        (
          await dataSource
            .getRepository(MaintenancePlan)
            .findOneByOrFail({ planId: psico.planId })
        ).subject,
      ).toBe(MaintenanceSubject.EMPLOYEE);
      const choferId = await legajo(
        admin1.headers,
        d1.distributorId,
        JobPositionCategory.DRIVER,
      );
      await cargarDocumento(admin1.headers, {
        planId: psico.planId,
        employeeId: choferId,
        dueAt: '2099-01-01T00:00:00.000Z',
        details: { examDate: '2098-01-01' },
      }).expect(400);
    });
  });
});
