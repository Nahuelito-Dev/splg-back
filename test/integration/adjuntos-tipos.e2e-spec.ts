/**
 * Adjuntos genéricos contra Postgres, Redis y MinIO reales: los owner types que
 * antes daban 400, los documentos Word/Excel/CSV (válidos 201, falsos 415, Word
 * como descarga), el aislamiento entre choferes en las rendiciones y la regla de
 * que a un pedido ya no se le suben adjuntos nuevos (los viejos sólo se leen).
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
import { startMinio, TestMinio } from './setup/minio';
import { PNG_REAL } from './setup/imagenes';
import { fechasSegunEstado } from './setup/pedido-valido';
import { zipDePrueba } from '../../src/common/utils/zip-de-prueba';
import { Admin } from '../../src/admin/entities/admin.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { DriverSettlement } from '../../src/driver-settlement/entities/driver-settlement.entity';
import { DriverSettlementStatus } from '../../src/driver-settlement/domain/driver-settlement.enums';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
} from '../../src/order/entities/order.entity';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import {
  Employee,
  EmployeeDocumentType,
  EmploymentType,
} from '../../src/employee/entities/employee.entity';
import {
  JobPosition,
  JobPositionCategory,
} from '../../src/employee/entities/job-position.entity';

type Headers = Record<string, string>;

const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('Adjuntos: tipos de dueño y documentos (e2e)', () => {
  let minio: TestMinio;
  let env: TestEnv;
  let ds: DataSource;
  let seq = 0;

  beforeAll(async () => {
    minio = await startMinio();
    env = await createTestApp({ s3: minio.env });
    ds = env.app.get(DataSource);
  }, 240000);

  afterAll(async () => {
    await env.cleanup();
    await minio.stop();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  const http = () => request(env.app.getHttpServer());

  /** Un legajo de la distribuidora A: dueño real de adjuntos con el que probar documentos. */
  async function empleado(e: { dA: Distributor }): Promise<string> {
    const puesto = await ds.getRepository(JobPosition).save({
      distributorId: e.dA.distributorId,
      name: 'Puesto de prueba',
      category: JobPositionCategory.OTHER,
    } as Partial<JobPosition>);
    const emp = await ds.getRepository(Employee).save({
      distributorId: e.dA.distributorId,
      positionId: puesto.positionId,
      fileNumber: '0001',
      firstName: 'Ana',
      lastName: 'Pérez',
      documentType: EmployeeDocumentType.DNI,
      documentNumber: randomUUID().slice(0, 8),
      hireDate: '2026-03-01',
      employmentType: EmploymentType.PERMANENT,
    } as Partial<Employee>);
    return emp.employeeId;
  }

  async function usuario(
    tipo: 'customer' | 'admin' | 'super_admin' | 'delivery',
    nombre: string,
  ) {
    seq += 1;
    const roles = ds.getRepository(Role);
    const rol =
      (await roles.findOne({ where: { type: tipo } })) ??
      (await roles.save({ type: tipo } as Partial<Role>));
    const email = `${tipo}.${seq}.${randomUUID().slice(0, 6)}@splg.local`;
    const user = await ds.getRepository(User).save({
      email,
      fullName: nombre,
      phoneNumber: telefonoDePrueba(),
      roleId: rol.roleId,
    } as Partial<User>);
    return { user, email };
  }

  async function escenario() {
    seq += 1;
    const dA = await ds.getRepository(Distributor).save({
      name: 'Dist A',
      slug: `dist-a-${seq}-${randomUUID().slice(0, 4)}`,
    } as Partial<Distributor>);
    const dB = await ds.getRepository(Distributor).save({
      name: 'Dist B',
      slug: `dist-b-${seq}-${randomUUID().slice(0, 4)}`,
    } as Partial<Distributor>);
    const adminA = await usuario('admin', 'Admin A');
    await ds.getRepository(Admin).save({
      userId: adminA.user.userId,
      distributorId: dA.distributorId,
    } as Partial<Admin>);
    const adminB = await usuario('admin', 'Admin B');
    await ds.getRepository(Admin).save({
      userId: adminB.user.userId,
      distributorId: dB.distributorId,
    } as Partial<Admin>);
    const sup = await usuario('super_admin', 'Super');
    const cli = await usuario('customer', 'Cliente Uno');
    await ds.getRepository(Customer).save({
      userId: cli.user.userId,
      notificationToken: 'fake',
    } as Partial<Customer>);
    const cli2 = await usuario('customer', 'Cliente Dos');
    await ds.getRepository(Customer).save({
      userId: cli2.user.userId,
      notificationToken: 'fake',
    } as Partial<Customer>);
    const dir = await ds.getRepository(UserAddress).save({
      userId: cli.user.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>);
    const h = (
      email: string,
      fuente: string,
      extra: Headers = {},
    ): Headers => ({
      Authorization: `Bearer ${email}`,
      'X-Client-Source': fuente,
      ...extra,
    });
    return {
      dA,
      dB,
      cli: cli.user,
      dir,
      adminA: h(adminA.email, 'panel-app'),
      adminB: h(adminB.email, 'panel-app'),
      supSinHeader: h(sup.email, 'panel-app'),
      supEnA: h(sup.email, 'panel-app', { 'X-Distributor': dA.slug }),
      cliente: h(cli.email, 'customer-app', { 'X-Distributor': dA.slug }),
      cliente2: h(cli2.email, 'customer-app', { 'X-Distributor': dA.slug }),
    };
  }
  type E = Awaited<ReturnType<typeof escenario>>;

  function pedido(e: E, parcial: Partial<Order> = {}): Promise<Order> {
    return ds.getRepository(Order).save({
      customerId: e.cli.userId,
      distributorId: e.dA.distributorId,
      addressId: e.dir.addressId,
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.CASH,
      paymentType: PaymentType.CASH,
      paymentStatus: PaymentStatus.PENDING,
      totalAmount: 1000,
      subtotalItems: 1000,
      ...fechasSegunEstado(parcial.status ?? OrderStatus.PENDING),
      ...parcial,
    } as Partial<Order>) as Promise<Order>;
  }

  describe('adjuntos: owner types que antes daban 400 y documentos', () => {
    it('driver_settlement, cash_movement y customer_account_entry ya no son 400: un id inexistente es 404', async () => {
      const e = await escenario();
      for (const tipo of [
        'driver_settlement',
        'cash_movement',
        'customer_account_entry',
        'order',
      ]) {
        await http()
          .get(`/attachments/${tipo}/${randomUUID()}`)
          .set(e.adminA)
          .expect(404);
      }
    });

    it('un pedido ya no recibe adjuntos nuevos (400), pero su lista de comprobantes viejos se lee', async () => {
      const e = await escenario();
      const p = await pedido(e);
      await http()
        .post(`/attachments/order/${p.orderId}`)
        .set(e.adminA)
        .attach('file', PNG_REAL, {
          filename: 'nuevo.png',
          contentType: 'image/png',
        })
        .expect(400);
      const lista = await http()
        .get(`/attachments/order/${p.orderId}`)
        .set(e.adminA)
        .expect(200);
      expect(lista.body).toEqual([]);
      expect(
        await ds.query('SELECT count(*)::int AS n FROM attachment'),
      ).toEqual([{ n: 0 }]);
    });

    it('acepta Word, Excel y CSV válidos y los baja como descarga; rechaza los falsos', async () => {
      const e = await escenario();
      const empleadoId = await empleado(e);
      const subir = (buffer: Buffer, nombre: string, mime: string) =>
        http()
          .post(`/attachments/employee/${empleadoId}`)
          .set(e.adminA)
          .attach('file', buffer, { filename: nombre, contentType: mime });
      const xlsx =
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

      const word = await subir(
        zipDePrueba(['[Content_Types].xml', 'word/document.xml']),
        'informe.docx',
        DOCX,
      ).expect(201);
      await subir(
        zipDePrueba(['[Content_Types].xml', 'xl/workbook.xml']),
        'planilla.xlsx',
        xlsx,
      ).expect(201);
      await subir(Buffer.from('a;b\n1;2\n'), 'lista.csv', 'text/csv').expect(
        201,
      );

      await subir(Buffer.from('MZ-ejecutable'), 'falso.docx', DOCX).expect(415);
      await subir(
        zipDePrueba(['[Content_Types].xml', 'word/document.xml']),
        'falso.xlsx',
        xlsx,
      ).expect(415);
      await subir(Buffer.from('<html></html>'), 'x.csv', 'text/csv').expect(
        415,
      );
      await subir(Buffer.from('x'), 'viejo.doc', 'application/msword').expect(
        415,
      );

      // Aunque pidan inline, un Word se entrega como descarga.
      const enlace = await http()
        .get(
          `/attachments/${(word.body as { attachmentId: string }).attachmentId}/download?modo=url&disposicion=inline`,
        )
        .set(e.adminA)
        .expect(200);
      const bajado = await fetch((enlace.body as { url: string }).url);
      expect(bajado.headers.get('content-disposition')).toMatch(/^attachment;/);
    });
  });

  describe('chofer y rendiciones: aislamiento entre choferes', () => {
    async function choferConRendicion(e: E, nombre: string, numero: number) {
      const u = await usuario('delivery', nombre);
      const del = await ds.getRepository(Delivery).save({
        userId: u.user.userId,
        distributorId: e.dA.distributorId,
        validated: true,
        isEnabled: true,
      } as Partial<Delivery>);
      const rendicion = await ds.getRepository(DriverSettlement).save({
        distributorId: e.dA.distributorId,
        deliveryId: del.deliveryId,
        number: numero,
        businessDate: '2026-10-27',
        status: DriverSettlementStatus.OPEN,
        expectedCash: 0,
        driverExpenses: 0,
      } as Partial<DriverSettlement>);
      return {
        headers: {
          Authorization: `Bearer ${u.email}`,
          'X-Client-Source': 'delivery-app',
        } as Headers,
        rendicionId: rendicion.settlementId,
      };
    }

    it('el chofer B no lista, sube ni descarga en la rendición del chofer A; A sí', async () => {
      const e = await escenario();
      const a = await choferConRendicion(e, 'Chofer A', 1);
      const b = await choferConRendicion(e, 'Chofer B', 2);
      const subir = (quien: Headers, rendicion: string) =>
        http()
          .post(`/attachments/driver_settlement/${rendicion}`)
          .set(quien)
          .attach('file', PNG_REAL, {
            filename: 't.png',
            contentType: 'image/png',
          });

      const subido = await subir(a.headers, a.rendicionId).expect(201);
      const id = (subido.body as { attachmentId: string }).attachmentId;

      await http()
        .get(`/attachments/driver_settlement/${a.rendicionId}`)
        .set(a.headers)
        .expect(200);
      await http()
        .get(`/attachments/${id}/download?modo=url`)
        .set(a.headers)
        .expect(200);

      await http()
        .get(`/attachments/driver_settlement/${a.rendicionId}`)
        .set(b.headers)
        .expect(404);
      await subir(b.headers, a.rendicionId).expect(404);
      await http()
        .get(`/attachments/${id}/download?modo=url`)
        .set(b.headers)
        .expect(404);
      await http().delete(`/attachments/${id}`).set(b.headers).expect(404);
      expect(
        await ds.query('SELECT count(*)::int AS n FROM attachment'),
      ).toEqual([{ n: 1 }]);
    });

    it('el chofer sólo sube PDF e imágenes, aunque la rendición sea suya', async () => {
      const e = await escenario();
      const a = await choferConRendicion(e, 'Chofer A', 1);
      await http()
        .post(`/attachments/driver_settlement/${a.rendicionId}`)
        .set(a.headers)
        .attach('file', Buffer.from('a;b\n'), {
          filename: 'x.csv',
          contentType: 'text/csv',
        })
        .expect(415);
      await http()
        .post(`/attachments/driver_settlement/${a.rendicionId}`)
        .set(a.headers)
        .attach(
          'file',
          zipDePrueba(['[Content_Types].xml', 'word/document.xml']),
          {
            filename: 'x.docx',
            contentType: DOCX,
          },
        )
        .expect(415);
    });

    it('el CSV de Excel en Windows (vnd.ms-excel, Windows-1252) lo sube el admin y queda como text/csv', async () => {
      const e = await escenario();
      const empleadoId = await empleado(e);
      const res = await http()
        .post(`/attachments/employee/${empleadoId}`)
        .set(e.adminA)
        .attach(
          'file',
          Buffer.from('nombre;ciudad\nJosé;Córdoba\n', 'latin1'),
          {
            filename: 'clientes.csv',
            contentType: 'application/vnd.ms-excel',
          },
        )
        .expect(201);
      expect(res.body).toMatchObject({ mimeType: 'text/csv' });
    });
  });
});
