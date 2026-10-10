/**
 * Fotos de las entidades (usuario, legajo, vehículo, producto, logo de la
 * distribuidora e incidencia) contra MinIO real en un contenedor efímero.
 * Cada entidad pasa por el mismo recorrido (subir, ver, reemplazar, sacar,
 * rechazos, otro tenant, permisos) y después van los casos propios de cada una.
 */
import { randomUUID } from 'crypto';
import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  truncateAllTables,
  telefonoDePrueba,
} from './setup/test-env';
import { BUCKET_DE_PRUEBA, TestMinio, startMinio } from './setup/minio';
import { generarImagenDemo } from '../../scripts/lib/imagenes-demo';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { Admin } from '../../src/admin/entities/admin.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { Car } from '../../src/car/entities/car.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import {
  Incident,
  IncidentType,
} from '../../src/incident/entities/incident.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import {
  Employee,
  EmployeeDocumentType,
  EmploymentType,
} from '../../src/employee/entities/employee.entity';
import { JobPositionService } from '../../src/employee/job-position.service';
import {
  JobPosition,
  JobPositionCategory,
} from '../../src/employee/entities/job-position.entity';
import { FirebaseAuthPort } from '../../src/firebase/ports/firebase-auth.port';
import { EmployeeService } from '../../src/employee/employee.service';
import { RoleType } from '../../src/common/constants/role-type.enum';
import { StorageOrphan } from '../../src/s3/entities/storage-orphan.entity';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('foto de prueba'),
]);
const JPG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('otra foto'),
]);
const HTML_COMO_PNG = Buffer.from('<html><script>alert(1)</script></html>');

type Headers = Record<string, string>;
type Cuerpo = Record<string, unknown>;

/** Espera (hasta ~5 s) a que se cumpla algo que ocurre en segundo plano. */
async function esperar(condicion: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (await condicion()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Lo que cada entidad le da al recorrido común. */
interface Caso {
  /** Ruta de `PUT|DELETE|GET .../photo` de la entidad creada. */
  ruta: string;
  /** Quien puede (admin de la distribuidora). */
  admin: Headers;
  /** Admin de OTRA distribuidora: la entidad no existe para él (404). */
  otroTenant: Headers;
  /** Quienes tienen sesión pero no permiso (403). */
  sinPermiso: Headers[];
  /** Campo del DTO que lleva la URL de la foto. */
  campo: string;
  /** La key guardada hoy en la base. */
  key: () => Promise<string | null>;
  /** Prefijo de las keys de esta entidad en el bucket. */
  prefijo: string;
  carpeta: RegExp;
  /** Lo que `GET` devuelve con `?modo=url` antes de subir nada. */
  urlSinFoto: string | null;
  /** Lectura normal de la entidad (listado o detalle) con su URL firmada. */
  leer: () => Promise<string | null>;
}

describe('Fotos de entidades en S3 (e2e)', () => {
  let minio: TestMinio;
  let env: TestEnv;
  let dataSource: DataSource;

  beforeAll(async () => {
    minio = await startMinio();
    env = await createTestApp({ s3: minio.env });
    dataSource = env.app.get(DataSource);
    // El alta de una cuenta crea el usuario en Firebase: acá no se llama.
    jest
      .spyOn(env.app.get(FirebaseAuthPort), 'createUserSafe')
      .mockImplementation((datos) =>
        Promise.resolve({ uid: `uid-${datos.email}` } as never),
      );
  }, 240000);

  afterAll(async () => {
    await env?.cleanup();
    await minio?.stop();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  const http = () => request(env.app.getHttpServer());

  async function existe(key: string): Promise<boolean> {
    try {
      await minio.client.send(
        new HeadObjectCommand({ Bucket: BUCKET_DE_PRUEBA, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async function claves(prefijo: string): Promise<string[]> {
    const r = await minio.client.send(
      new ListObjectsV2Command({ Bucket: BUCKET_DE_PRUEBA, Prefix: prefijo }),
    );
    return (r.Contents ?? []).map((c) => c.Key ?? '');
  }

  // ── Datos ──────────────────────────────────────────────────────────────────

  async function rol(type: string): Promise<Role> {
    const roles = dataSource.getRepository(Role);
    return (
      (await roles.findOne({ where: { type } })) ??
      (await roles.save({ type } as Partial<Role>))
    );
  }

  async function seedDistribuidora(extra: Partial<Distributor> = {}) {
    const sufijo = randomUUID().slice(0, 8);
    return (await dataSource.getRepository(Distributor).save({
      name: `Distribuidora ${sufijo}`,
      slug: `dist-${sufijo}`,
      ...extra,
    } as Partial<Distributor>)) as Distributor;
  }

  async function seedUsuario(tipo: string, nombre = tipo) {
    const sufijo = randomUUID().slice(0, 8);
    const email = `${nombre}.${sufijo}@splg.local`;
    const user = (await dataSource.getRepository(User).save({
      email,
      fullName: `Test ${nombre}`,
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol(tipo)).roleId,
    } as Partial<User>)) as User;
    return { user, email };
  }

  async function seedAdmin(distributorId: string | null) {
    const { user, email } = await seedUsuario(
      distributorId ? 'admin' : 'super_admin',
    );
    await dataSource
      .getRepository(Admin)
      .save({ userId: user.userId, distributorId } as Partial<Admin>);
    const headers: Headers = {
      Authorization: `Bearer ${email}`,
      'X-Client-Source': 'panel-app',
    };
    return { user, headers };
  }

  async function seedChofer(distributorId: string) {
    const { user, email } = await seedUsuario('delivery', 'chofer');
    await dataSource
      .getRepository(Delivery)
      .save({ distributorId, userId: user.userId } as Partial<Delivery>);
    const headers: Headers = {
      Authorization: `Bearer ${email}`,
      'X-Client-Source': 'delivery-app',
    };
    return { user, headers };
  }

  async function seedCliente(distribuidora: Distributor) {
    const { user, email } = await seedUsuario('customer', 'cliente');
    await dataSource.getRepository(Customer).save({
      userId: user.userId,
      notificationToken: 'fake',
    } as Partial<Customer>);
    const headers: Headers = {
      Authorization: `Bearer ${email}`,
      'X-Client-Source': 'customer-app',
      'X-Distributor': distribuidora.slug,
    };
    return { user, headers };
  }

  /** Dos distribuidoras, cada una con su admin. */
  async function escenario() {
    const d1 = await seedDistribuidora();
    const d2 = await seedDistribuidora();
    return {
      d1,
      d2,
      admin1: await seedAdmin(d1.distributorId),
      admin2: await seedAdmin(d2.distributorId),
      superAdmin: await seedAdmin(null),
    };
  }

  const subir = (
    ruta: string,
    headers: Headers,
    buffer: Buffer = PNG,
    mime = 'image/png',
  ) =>
    http()
      .put(ruta)
      .set(headers)
      .attach('file', buffer, { filename: 'foto', contentType: mime });

  // ── Entidades ──────────────────────────────────────────────────────────────

  type Armar = () => Promise<Caso>;

  const armarVehiculo: Armar = async () => {
    const { d1, admin1, admin2 } = await escenario();
    const cliente = await seedCliente(d1);
    const chofer = await seedChofer(d1.distributorId);
    const car = (await dataSource.getRepository(Car).save({
      distributorId: d1.distributorId,
      userId: chofer.user.userId,
      carPatent: `TST${randomUUID().slice(0, 6).toUpperCase()}`,
      carBrand: 'Fiat',
      carModel: 'Fiorino',
    } as Partial<Car>)) as Car;
    return {
      ruta: `/car/${car.carId}/photo`,
      admin: admin1.headers,
      otroTenant: admin2.headers,
      sinPermiso: [cliente.headers, chofer.headers],
      campo: 'photoUrl',
      key: async () =>
        (
          await dataSource
            .getRepository(Car)
            .findOneByOrFail({ carId: car.carId })
        ).photoKey,
      prefijo: `cars/${d1.distributorId}/`,
      carpeta: new RegExp(
        `^cars/${d1.distributorId}/${car.carId}/[0-9a-f-]{36}\\.(png|jpg)$`,
      ),
      urlSinFoto: null,
      leer: async () => {
        const res = await http()
          .get(`/car/${car.carId}`)
          .set(admin1.headers)
          .expect(200);
        return (res.body as Cuerpo).photoUrl as string | null;
      },
    };
  };

  const armarProducto: Armar = async () => {
    const { d1, admin1, admin2 } = await escenario();
    const cliente = await seedCliente(d1);
    const chofer = await seedChofer(d1.distributorId);
    const producto = (await dataSource.getRepository(GasCylinder).save({
      type: '10kg',
      price: 1000,
      stock: 10,
      weight: 10,
      isActive: true,
      distributorId: d1.distributorId,
    } as Partial<GasCylinder>)) as GasCylinder;
    return {
      ruta: `/gascylinder/${producto.gasCylinderId}/photo`,
      admin: admin1.headers,
      otroTenant: admin2.headers,
      sinPermiso: [cliente.headers, chofer.headers],
      campo: 'photoUrl',
      key: async () =>
        (
          await dataSource
            .getRepository(GasCylinder)
            .findOneByOrFail({ gasCylinderId: producto.gasCylinderId })
        ).photoKey,
      prefijo: `gascylinders/${d1.distributorId}/`,
      carpeta: new RegExp(
        `^gascylinders/${d1.distributorId}/${producto.gasCylinderId}/[0-9a-f-]{36}\\.(png|jpg)$`,
      ),
      urlSinFoto: null,
      leer: async () => {
        const res = await http()
          .get(`/gascylinder/${producto.gasCylinderId}`)
          .set(admin1.headers)
          .expect(200);
        return (res.body as Cuerpo).photoUrl as string | null;
      },
    };
  };

  const FOTO_EXTERNA = 'https://externa.example/foto-vieja.jpg';

  /** Un pedido entregado de `customerId`: lo que hace "de la distribuidora" a un cliente. */
  async function seedPedido(distributorId: string, customerId: string) {
    const address = (await dataSource.getRepository(UserAddress).save({
      userId: customerId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>)) as UserAddress;
    return (await dataSource.getRepository(Order).save({
      distributorId,
      customerId,
      addressId: address.addressId,
      status: OrderStatus.DELIVERED,
      paymentMethod: PaymentMethod.CASH,
      subtotalItems: 1000,
      totalAmount: 1000,
    } as Partial<Order>)) as Order;
  }

  async function seedIncidencia(
    distributorId: string,
    reportedBy: string,
    photoUrl: string | null = FOTO_EXTERNA,
  ) {
    const cliente = await seedUsuario('customer', 'cliente');
    await dataSource.getRepository(Customer).save({
      userId: cliente.user.userId,
      notificationToken: 'fake',
    } as Partial<Customer>);
    const pedido = await seedPedido(distributorId, cliente.user.userId);
    return (await dataSource.getRepository(Incident).save({
      orderId: pedido.orderId,
      distributorId,
      reportedBy,
      type: IncidentType.DAMAGED,
      description: 'Válvula golpeada',
      photoUrl,
    } as Partial<Incident>)) as Incident;
  }

  const armarIncidencia: Armar = async () => {
    const { d1, admin1, admin2 } = await escenario();
    const reportante = await seedChofer(d1.distributorId);
    const otroChofer = await seedChofer(d1.distributorId);
    const cliente = await seedCliente(d1);
    const incidencia = await seedIncidencia(
      d1.distributorId,
      reportante.user.userId,
    );
    return {
      ruta: `/incidents/${incidencia.incidentId}/photo`,
      admin: admin1.headers,
      otroTenant: admin2.headers,
      sinPermiso: [cliente.headers, otroChofer.headers],
      campo: 'photo_url',
      key: async () =>
        (
          await dataSource
            .getRepository(Incident)
            .findOneByOrFail({ incidentId: incidencia.incidentId })
        ).photoKey,
      prefijo: `incidents/${d1.distributorId}/`,
      carpeta: new RegExp(
        `^incidents/${d1.distributorId}/${incidencia.incidentId}/[0-9a-f-]{36}\\.(png|jpg)$`,
      ),
      urlSinFoto: FOTO_EXTERNA,
      leer: async () => {
        const res = await http()
          .get('/incidents')
          .set(admin1.headers)
          .expect(200);
        return (res.body as Cuerpo[])[0].photo_url as string | null;
      },
    };
  };

  const armarLogo: Armar = async () => {
    const { d1, admin1, admin2 } = await escenario();
    const cliente = await seedCliente(d1);
    return {
      ruta: `/distributor/${d1.distributorId}/logo`,
      admin: admin1.headers,
      otroTenant: admin2.headers,
      sinPermiso: [cliente.headers],
      campo: 'photoUrl',
      key: async () =>
        (
          await dataSource
            .getRepository(Distributor)
            .findOneByOrFail({ distributorId: d1.distributorId })
        ).logoKey,
      prefijo: `distributors/${d1.distributorId}/`,
      carpeta: new RegExp(
        `^distributors/${d1.distributorId}/logo/[0-9a-f-]{36}\\.(png|jpg)$`,
      ),
      urlSinFoto: null,
      leer: async () => {
        const res = await http()
          .get('/distributor/current')
          .set(admin1.headers)
          .expect(200);
        return (res.body as Cuerpo).photoUrl as string | null;
      },
    };
  };

  const armarUsuario: Armar = async () => {
    const { d1, admin1, admin2 } = await escenario();
    const cliente = await seedCliente(d1);
    const chofer = await seedChofer(d1.distributorId);
    return {
      ruta: `/users/${chofer.user.userId}/photo`,
      admin: admin1.headers,
      otroTenant: admin2.headers,
      sinPermiso: [cliente.headers, chofer.headers],
      campo: 'photoUrl',
      key: async () =>
        (
          await dataSource
            .getRepository(User)
            .findOneByOrFail({ userId: chofer.user.userId })
        ).photoKey,
      prefijo: `users/${chofer.user.userId}/`,
      carpeta: new RegExp(
        `^users/${chofer.user.userId}/[0-9a-f-]{36}\\.(png|jpg)$`,
      ),
      urlSinFoto: null,
      leer: async () => {
        const res = await http()
          .get(`/users/${chofer.user.userId}`)
          .set(admin1.headers)
          .expect(200);
        return (res.body as Cuerpo).photoUrl as string | null;
      },
    };
  };

  async function seedLegajo(
    distributorId: string,
    userId: string | null,
    positionId?: string,
  ) {
    await env.app.get(JobPositionService).sembrarBase(distributorId);
    const puesto = await dataSource.getRepository('JobPosition').findOneOrFail({
      where: { distributorId, category: JobPositionCategory.HELPER },
    });
    const repo = dataSource.getRepository(Employee);
    return repo.save(
      repo.create({
        distributorId,
        userId,
        positionId: positionId ?? (puesto as { positionId: string }).positionId,
        fileNumber: `L${randomUUID().slice(0, 6)}`,
        firstName: 'Ana',
        lastName: 'Pérez',
        documentType: EmployeeDocumentType.DNI,
        documentNumber: randomUUID().slice(0, 8),
        hireDate: '2026-01-01',
        employmentType: EmploymentType.PERMANENT,
      }),
    );
  }

  const armarLegajo: Armar = async () => {
    const { d1, admin1, admin2 } = await escenario();
    const cliente = await seedCliente(d1);
    const chofer = await seedChofer(d1.distributorId);
    const legajo = await seedLegajo(d1.distributorId, null);
    return {
      ruta: `/employees/${legajo.employeeId}/photo`,
      admin: admin1.headers,
      otroTenant: admin2.headers,
      sinPermiso: [cliente.headers, chofer.headers],
      campo: 'photoUrl',
      key: async () =>
        (
          await dataSource
            .getRepository(Employee)
            .findOneByOrFail({ employeeId: legajo.employeeId })
        ).photoKey,
      prefijo: `employees/${d1.distributorId}/`,
      carpeta: new RegExp(
        `^employees/${d1.distributorId}/${legajo.employeeId}/[0-9a-f-]{36}\\.(png|jpg)$`,
      ),
      urlSinFoto: null,
      leer: async () => {
        const res = await http()
          .get(`/employees/${legajo.employeeId}`)
          .set(admin1.headers)
          .expect(200);
        return (res.body as Cuerpo).photoUrl as string | null;
      },
    };
  };

  const casos: Array<[string, Armar]> = [
    ['vehículo', armarVehiculo],
    ['producto', armarProducto],
    ['incidencia', armarIncidencia],
    ['logo de la distribuidora', armarLogo],
    ['usuario (por id)', armarUsuario],
    ['legajo', armarLegajo],
  ];

  describe.each(casos)('recorrido común: %s', (_nombre, armar) => {
    it('sin foto: modo=url es 200 y el archivo es 404 (sin respaldo)', async () => {
      const c = await armar();
      const link = await http()
        .get(`${c.ruta}?modo=url`)
        .set(c.admin)
        .expect(200);
      expect((link.body as Cuerpo).url).toBe(c.urlSinFoto);
      expect((link.body as Cuerpo).requiresAuth).toBe(false);
      if (c.urlSinFoto) {
        // Con respaldo externo (incidencia) no se redirige (open redirect):
        // la URL va en JSON.
        const directo = await http()
          .get(c.ruta)
          .set(c.admin)
          .redirects(0)
          .expect(200);
        expect((directo.body as Cuerpo).url).toBe(c.urlSinFoto);
      } else {
        await http().get(c.ruta).set(c.admin).expect(404);
      }
    });

    it('subir -> se ve por URL firmada -> reemplazar borra la anterior -> sacar la borra', async () => {
      const c = await armar();

      const primera = await subir(c.ruta, c.admin).expect(200);
      const url1 = (primera.body as Cuerpo)[c.campo] as string;
      expect(url1).toContain(BUCKET_DE_PRUEBA);
      const key1 = (await c.key()) ?? '';
      expect(key1).toMatch(c.carpeta);
      expect(key1).toMatch(/\.png$/);
      const head = await minio.client.send(
        new HeadObjectCommand({ Bucket: BUCKET_DE_PRUEBA, Key: key1 }),
      );
      expect(head.ServerSideEncryption).toBe('AES256');
      expect(head.ContentType).toBe('image/png');

      // La URL de la respuesta y la de la lectura normal sirven la imagen.
      for (const url of [url1, await c.leer()]) {
        const res = await fetch(url ?? '');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/png');
        expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
      }
      // El bucket es privado: la key sin firma no se lee.
      expect(
        (await fetch(`${minio.endpoint}/${BUCKET_DE_PRUEBA}/${key1}`)).status,
      ).toBe(403);

      const link = await http()
        .get(`${c.ruta}?modo=url`)
        .set(c.admin)
        .expect(200);
      const enlace = link.body as { url: string; expiresAt: string };
      expect(new Date(enlace.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect((await fetch(enlace.url)).status).toBe(200);
      const redirect = await http()
        .get(c.ruta)
        .set(c.admin)
        .redirects(0)
        .expect(302);
      expect(redirect.headers.location).toContain(BUCKET_DE_PRUEBA);

      // Reemplazo: queda sólo la foto nueva y la vieja se manda a borrar.
      await subir(c.ruta, c.admin, JPG, 'image/jpeg').expect(200);
      const key2 = (await c.key()) ?? '';
      expect(key2).not.toBe(key1);
      expect(key2).toMatch(/\.jpg$/);
      expect(await esperar(async () => !(await existe(key1)))).toBe(true);
      expect(await claves(c.prefijo)).toEqual([key2]);

      // Sacar la foto: la referencia queda en null y el objeto se borra.
      const sin = await http().delete(c.ruta).set(c.admin).expect(200);
      expect((sin.body as Cuerpo)[c.campo]).toBe(c.urlSinFoto);
      expect(await c.key()).toBeNull();
      expect(await esperar(async () => !(await existe(key2)))).toBe(true);
      expect(await claves(c.prefijo)).toEqual([]);
      expect(
        await esperar(
          async () =>
            (await dataSource.getRepository(StorageOrphan).count()) === 0,
        ),
      ).toBe(true);
      // Sacar una foto que no hay no falla.
      await http().delete(c.ruta).set(c.admin).expect(200);
    });

    it('rechaza lo que no es imagen (415), lo demasiado grande (413) y el pedido sin archivo (400), sin dejar nada en el bucket', async () => {
      const c = await armar();
      await subir(c.ruta, c.admin, HTML_COMO_PNG, 'image/png').expect(415);
      await subir(
        c.ruta,
        c.admin,
        Buffer.from('%PDF-1.4 x'),
        'application/pdf',
      ).expect(415);
      // Un PNG declarado como JPEG: la firma no coincide.
      await subir(c.ruta, c.admin, PNG, 'image/jpeg').expect(415);
      // Pasa el tope técnico de Multer pero no los 5 MB de negocio.
      await subir(
        c.ruta,
        c.admin,
        Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]),
      ).expect(413);
      // Pasa de largo el tope técnico.
      await subir(
        c.ruta,
        c.admin,
        Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]),
      ).expect(413);
      await http().put(c.ruta).set(c.admin).expect(400);
      expect(await claves(c.prefijo)).toEqual([]);
      expect(await c.key()).toBeNull();
    });

    it('el admin de otra distribuidora recibe 404 en las tres operaciones y no cambia nada', async () => {
      const c = await armar();
      await subir(c.ruta, c.admin).expect(200);
      const key = await c.key();
      await subir(c.ruta, c.otroTenant, JPG, 'image/jpeg').expect(404);
      await http().delete(c.ruta).set(c.otroTenant).expect(404);
      await http().get(`${c.ruta}?modo=url`).set(c.otroTenant).expect(404);
      expect(await c.key()).toBe(key);
      expect(await claves(c.prefijo)).toEqual([key]);
    });

    it('quien no tiene el rol no sube ni saca (403)', async () => {
      const c = await armar();
      for (const quien of c.sinPermiso) {
        const res = await subir(c.ruta, quien);
        expect([403]).toContain(res.status);
        await http().delete(c.ruta).set(quien).expect(403);
      }
      expect(await claves(c.prefijo)).toEqual([]);
    });

    it('un id que no existe es 404 y un id mal formado es 400', async () => {
      const c = await armar();
      const otra = c.ruta.replace(/[0-9a-f-]{36}/, randomUUID());
      await subir(otra, c.admin).expect(404);
      const rota = c.ruta.replace(/[0-9a-f-]{36}/, 'no-es-uuid');
      await subir(rota, c.admin).expect(400);
    });
  });

  // ── Casos propios ──────────────────────────────────────────────────────────

  describe('usuario: foto de perfil', () => {
    it('cada uno sube, ve y saca la suya por /users/me/photo', async () => {
      const { d1 } = await escenario();
      const cliente = await seedCliente(d1);
      const chofer = await seedChofer(d1.distributorId);
      for (const quien of [cliente, chofer]) {
        const res = await subir('/users/me/photo', quien.headers).expect(200);
        const dto = res.body as Cuerpo;
        expect(dto.user_id).toBe(quien.user.userId);
        expect(dto.photoUrl).toContain(BUCKET_DE_PRUEBA);
        const link = await http()
          .get('/users/me/photo?modo=url')
          .set(quien.headers)
          .expect(200);
        expect((await fetch((link.body as Cuerpo).url as string)).status).toBe(
          200,
        );
      }
      await http().delete('/users/me/photo').set(cliente.headers).expect(200);
      expect(
        (
          await dataSource
            .getRepository(User)
            .findOneByOrFail({ userId: cliente.user.userId })
        ).photoKey,
      ).toBeNull();
      // La del chofer sigue.
      expect(
        (
          await dataSource
            .getRepository(User)
            .findOneByOrFail({ userId: chofer.user.userId })
        ).photoKey,
      ).not.toBeNull();
    });

    it('el admin sube la de un chofer y la ve en el listado de usuarios', async () => {
      const { d1, admin1 } = await escenario();
      const chofer = await seedChofer(d1.distributorId);
      await subir(`/users/${chofer.user.userId}/photo`, admin1.headers).expect(
        200,
      );
      const lista = await http().get('/users').set(admin1.headers).expect(200);
      const fila = (
        lista.body as {
          users: Array<{ user_id: string; photoUrl: string | null }>;
        }
      ).users.find((u) => u.user_id === chofer.user.userId);
      expect(fila?.photoUrl).toContain(BUCKET_DE_PRUEBA);
    });

    it('un cliente no sube ni ve la foto de otro; tampoco la de un chofer', async () => {
      const { d1 } = await escenario();
      const a = await seedCliente(d1);
      const b = await seedCliente(d1);
      const chofer = await seedChofer(d1.distributorId);
      await subir(`/users/${b.user.userId}/photo`, a.headers).expect(403);
      await http()
        .delete(`/users/${b.user.userId}/photo`)
        .set(a.headers)
        .expect(403);
      await http()
        .get(`/users/${b.user.userId}/photo?modo=url`)
        .set(a.headers)
        .expect(403);
      await subir(`/users/${chofer.user.userId}/photo`, a.headers).expect(403);
      for (const u of [a, b, chofer]) {
        expect(await claves(`users/${u.user.userId}/`)).toEqual([]);
      }
    });

    it('el admin de empresa no toca la foto de un cliente (403); el super admin sí', async () => {
      const { d1, admin1, superAdmin } = await escenario();
      const cliente = await seedCliente(d1);
      await seedPedido(d1.distributorId, cliente.user.userId);
      const ruta = `/users/${cliente.user.userId}/photo`;
      await subir(ruta, admin1.headers).expect(403);
      await subir(ruta, {
        ...superAdmin.headers,
        'X-Distributor': d1.slug,
      }).expect(200);
    });

    it('el admin no ve al super admin: 404', async () => {
      const { admin1, superAdmin } = await escenario();
      await subir(
        `/users/${superAdmin.user.userId}/photo`,
        admin1.headers,
      ).expect(404);
    });
  });

  describe('usuario anidado en chofer y cliente', () => {
    it('el chofer y el cliente salen con user.photoUrl firmada (detalle, por usuario y listado)', async () => {
      const { d1, admin1 } = await escenario();
      const chofer = await seedChofer(d1.distributorId);
      const cliente = await seedCliente(d1);
      await seedPedido(d1.distributorId, cliente.user.userId);
      await subir(`/users/${chofer.user.userId}/photo`, admin1.headers).expect(
        200,
      );
      await subir(`/users/${cliente.user.userId}/photo`, {
        ...(await seedAdmin(null)).headers,
        'X-Distributor': d1.slug,
      }).expect(200);

      type ConUsuario = { user?: { photoUrl: string | null; user_id: string } };
      const fotoDe = (fila: ConUsuario | undefined) => fila?.user?.photoUrl;

      const deliveryId = (
        await dataSource
          .getRepository(Delivery)
          .findOneByOrFail({ userId: chofer.user.userId })
      ).deliveryId;
      const customerId = (
        await dataSource
          .getRepository(Customer)
          .findOneByOrFail({ userId: cliente.user.userId })
      ).customerId;

      const detalle = await http()
        .get(`/delivery/${deliveryId}`)
        .set(admin1.headers)
        .expect(200);
      expect(fotoDe(detalle.body as ConUsuario)).toContain(BUCKET_DE_PRUEBA);
      const porUsuario = await http()
        .get(`/delivery/user/${chofer.user.userId}`)
        .set(admin1.headers)
        .expect(200);
      expect(fotoDe(porUsuario.body as ConUsuario)).toContain(BUCKET_DE_PRUEBA);
      const lista = await http()
        .get('/delivery')
        .set(admin1.headers)
        .expect(200);
      expect(
        fotoDe(
          (lista.body as ConUsuario[]).find(
            (f) => f.user?.user_id === chofer.user.userId,
          ),
        ),
      ).toContain(BUCKET_DE_PRUEBA);

      const cDetalle = await http()
        .get(`/customers/${customerId}`)
        .set(admin1.headers)
        .expect(200);
      expect(fotoDe(cDetalle.body as ConUsuario)).toContain(BUCKET_DE_PRUEBA);
      const cPorUsuario = await http()
        .get(`/customers/user/${cliente.user.userId}`)
        .set(admin1.headers)
        .expect(200);
      expect(fotoDe(cPorUsuario.body as ConUsuario)).toContain(
        BUCKET_DE_PRUEBA,
      );
      const cLista = await http()
        .get('/customers')
        .set(admin1.headers)
        .expect(200);
      expect(
        fotoDe(
          (cLista.body as ConUsuario[]).find(
            (f) => f.user?.user_id === cliente.user.userId,
          ),
        ),
      ).toContain(BUCKET_DE_PRUEBA);
    });

    it('el aislamiento sigue: el admin de otra distribuidora recibe 404 del chofer', async () => {
      const { d1, admin2 } = await escenario();
      const chofer = await seedChofer(d1.distributorId);
      await http()
        .get(`/delivery/user/${chofer.user.userId}`)
        .set(admin2.headers)
        .expect(404);
    });

    it('el super admin en "ver como" sube, ve y saca su propia foto', async () => {
      const { d1, superAdmin } = await escenario();
      const headers = { ...superAdmin.headers, 'X-Distributor': d1.slug };
      const ruta = `/users/${superAdmin.user.userId}/photo`;
      await subir(ruta, headers).expect(200);
      await http().get(`${ruta}?modo=url`).set(headers).expect(200);
      await http().delete(ruta).set(headers).expect(200);
    });
  });

  describe('legajo', () => {
    it('con cuenta de acceso, la foto del legajo es la del usuario y no se sube aparte', async () => {
      const { d1, admin1 } = await escenario();
      const chofer = await seedChofer(d1.distributorId);
      const legajo = await seedLegajo(d1.distributorId, chofer.user.userId);
      const ruta = `/employees/${legajo.employeeId}/photo`;

      const sin = await http()
        .get(`/employees/${legajo.employeeId}`)
        .set(admin1.headers)
        .expect(200);
      expect((sin.body as Cuerpo).photoUrl).toBeNull();

      // Aparte no se puede: es la del usuario.
      await subir(ruta, admin1.headers).expect(409);
      await http().delete(ruta).set(admin1.headers).expect(409);

      await subir(`/users/${chofer.user.userId}/photo`, admin1.headers).expect(
        200,
      );
      const key = (
        await dataSource
          .getRepository(User)
          .findOneByOrFail({ userId: chofer.user.userId })
      ).photoKey;
      const detalle = await http()
        .get(`/employees/${legajo.employeeId}`)
        .set(admin1.headers)
        .expect(200);
      expect((detalle.body as Cuerpo).photoUrl).toContain(key ?? '?');
      const lista = await http()
        .get('/employees')
        .set(admin1.headers)
        .expect(200);
      expect(
        (lista.body as { data: Array<{ photoUrl: string | null }> }).data[0]
          .photoUrl,
      ).toContain(key ?? '?');
      // `GET .../photo` del legajo sirve la del usuario.
      const link = await http()
        .get(`${ruta}?modo=url`)
        .set(admin1.headers)
        .expect(200);
      expect((await fetch((link.body as Cuerpo).url as string)).status).toBe(
        200,
      );
      expect(
        (
          await dataSource
            .getRepository(Employee)
            .findOneByOrFail({ employeeId: legajo.employeeId })
        ).photoKey,
      ).toBeNull();
    });

    it('al otorgar cuenta, la foto del legajo pasa al usuario y el legajo queda sin key propia', async () => {
      const { d1, admin1 } = await escenario();
      await rol('delivery');
      await env.app.get(JobPositionService).sembrarBase(d1.distributorId);
      const puesto = await dataSource
        .getRepository(JobPosition)
        .findOneByOrFail({
          distributorId: d1.distributorId,
          category: JobPositionCategory.DRIVER,
        });
      const legajo = await seedLegajo(
        d1.distributorId,
        null,
        puesto.positionId,
      );
      await subir(
        `/employees/${legajo.employeeId}/photo`,
        admin1.headers,
      ).expect(200);
      const key = (
        await dataSource
          .getRepository(Employee)
          .findOneByOrFail({ employeeId: legajo.employeeId })
      ).photoKey as string;

      const res = await http()
        .post(`/employees/${legajo.employeeId}/account`)
        .set(admin1.headers)
        .send({
          email: `nuevo.${randomUUID().slice(0, 8)}@splg.local`,
          password: 'Test1234',
          phoneNumber: telefonoDePrueba(),
        })
        .expect(200);
      expect((res.body as Cuerpo).photoUrl).toContain(key);
      const emp = await dataSource
        .getRepository(Employee)
        .findOneByOrFail({ employeeId: legajo.employeeId });
      expect(emp.photoKey).toBeNull();
      expect(emp.userId).not.toBeNull();
      expect(
        (
          await dataSource
            .getRepository(User)
            .findOneByOrFail({ userId: emp.userId as string })
        ).photoKey,
      ).toBe(key);
      expect(await existe(key)).toBe(true);
      expect(
        await dataSource
          .getRepository(StorageOrphan)
          .count({ where: { storageKey: key } }),
      ).toBe(0);
    });

    it('si el usuario ya tiene foto, la del legajo va a limpieza en la misma transacción', async () => {
      const { d1, admin1 } = await escenario();
      await env.app.get(JobPositionService).sembrarBase(d1.distributorId);
      const puesto = await dataSource
        .getRepository(JobPosition)
        .findOneByOrFail({
          distributorId: d1.distributorId,
          category: JobPositionCategory.DRIVER,
        });
      const chofer = await seedChofer(d1.distributorId);
      await subir(`/users/${chofer.user.userId}/photo`, admin1.headers).expect(
        200,
      );
      const keyUsuario = (
        await dataSource
          .getRepository(User)
          .findOneByOrFail({ userId: chofer.user.userId })
      ).photoKey as string;
      const legajo = await seedLegajo(
        d1.distributorId,
        null,
        puesto.positionId,
      );
      await subir(
        `/employees/${legajo.employeeId}/photo`,
        admin1.headers,
      ).expect(200);
      const keyLegajo = (
        await dataSource
          .getRepository(Employee)
          .findOneByOrFail({ employeeId: legajo.employeeId })
      ).photoKey as string;

      await dataSource.transaction((manager) =>
        env.app.get(EmployeeService).vincularUsuario(manager, {
          employeeId: legajo.employeeId,
          userId: chofer.user.userId,
          distributorId: d1.distributorId,
          rol: RoleType.DELIVERY,
        }),
      );
      expect(
        (
          await dataSource
            .getRepository(User)
            .findOneByOrFail({ userId: chofer.user.userId })
        ).photoKey,
      ).toBe(keyUsuario);
      expect(
        (
          await dataSource
            .getRepository(Employee)
            .findOneByOrFail({ employeeId: legajo.employeeId })
        ).photoKey,
      ).toBeNull();
      expect(
        await dataSource
          .getRepository(StorageOrphan)
          .count({ where: { storageKey: keyLegajo } }),
      ).toBe(1);
    });
  });

  describe('producto: lo ven las apps en el catálogo', () => {
    it('la imagen sale en el catálogo público, en el cliente y en el listado del panel', async () => {
      const { d1, admin1 } = await escenario();
      const cliente = await seedCliente(d1);
      const [foto, sinFoto] = await Promise.all(
        ['10kg', '15kg'].map((type) =>
          dataSource.getRepository(GasCylinder).save({
            type,
            price: 1000,
            stock: 10,
            weight: 10,
            isActive: true,
            distributorId: d1.distributorId,
          } as Partial<GasCylinder>),
        ),
      );
      await subir(
        `/gascylinder/${foto.gasCylinderId}/photo`,
        admin1.headers,
      ).expect(200);

      const tieneFoto = (productos: Cuerpo[]) =>
        productos.map((p) => [p.type, p.photoUrl !== null]).sort();
      const esperado = [
        ['10kg', true],
        ['15kg', false],
      ];

      const publico = await http()
        .get(`/gascylinder/available/list?distributor=${d1.slug}`)
        .expect(200);
      expect(
        tieneFoto((publico.body as { products: Cuerpo[] }).products),
      ).toEqual(esperado);
      const propio = await http()
        .get('/gascylinder/available/list')
        .set(cliente.headers)
        .expect(200);
      expect(
        tieneFoto((propio.body as { products: Cuerpo[] }).products),
      ).toEqual(esperado);
      const catalogo = await http()
        .get('/gascylinder')
        .set(admin1.headers)
        .expect(200);
      expect(
        tieneFoto((catalogo.body as { gasCylinders: Cuerpo[] }).gasCylinders),
      ).toEqual(esperado);
      const porTipo = await http()
        .get('/gascylinder/type/10kg')
        .set(cliente.headers)
        .expect(200);
      expect((porTipo.body as Cuerpo).photoUrl).toContain(BUCKET_DE_PRUEBA);

      // La imagen se ve sin sesión (catálogo público).
      const link = await http()
        .get(`/gascylinder/${foto.gasCylinderId}/photo?modo=url`)
        .expect(200);
      expect((await fetch((link.body as Cuerpo).url as string)).status).toBe(
        200,
      );
      expect(sinFoto.gasCylinderId).toBeDefined();

      // Editar el producto no pierde la imagen.
      await http()
        .patch(`/gascylinder/${foto.gasCylinderId}`)
        .set(admin1.headers)
        .send({ price: 1500 })
        .expect(200);
      expect(
        (
          await dataSource
            .getRepository(GasCylinder)
            .findOneByOrFail({ gasCylinderId: foto.gasCylinderId })
        ).photoKey,
      ).not.toBeNull();
    });

    it('un producto dado de baja no sirve su imagen en el camino público; el panel sí la ve', async () => {
      const { d1, admin1 } = await escenario();
      const producto = await dataSource.getRepository(GasCylinder).save({
        type: '5kg',
        price: 1,
        stock: 1,
        weight: 5,
        isActive: true,
        distributorId: d1.distributorId,
      } as Partial<GasCylinder>);
      const ruta = `/gascylinder/${producto.gasCylinderId}/photo`;
      await subir(ruta, admin1.headers).expect(200);
      await http().get(`${ruta}?modo=url`).expect(200);
      await dataSource
        .getRepository(GasCylinder)
        .update({ gasCylinderId: producto.gasCylinderId }, { isActive: false });
      await http().get(`${ruta}?modo=url`).expect(404);
      await http().get(ruta).redirects(0).expect(404);
      await http().get(`${ruta}?modo=url`).set(admin1.headers).expect(200);
    });

    it('el super admin necesita elegir la distribuidora (X-Distributor)', async () => {
      const { d1, superAdmin } = await escenario();
      const producto = await dataSource.getRepository(GasCylinder).save({
        type: '5kg',
        price: 1,
        stock: 1,
        weight: 5,
        isActive: true,
        distributorId: d1.distributorId,
      } as Partial<GasCylinder>);
      const ruta = `/gascylinder/${producto.gasCylinderId}/photo`;
      await subir(ruta, superAdmin.headers).expect(400);
      await subir(ruta, {
        ...superAdmin.headers,
        'X-Distributor': d1.slug,
      }).expect(200);
    });
  });

  describe('incidencia', () => {
    it('el chofer que la reportó sube y saca la foto; otro chofer no (403)', async () => {
      const { d1 } = await escenario();
      const reportante = await seedChofer(d1.distributorId);
      const otro = await seedChofer(d1.distributorId);
      const incidencia = await seedIncidencia(
        d1.distributorId,
        reportante.user.userId,
      );
      const ruta = `/incidents/${incidencia.incidentId}/photo`;

      await subir(ruta, otro.headers).expect(403);
      await http().get(`${ruta}?modo=url`).set(otro.headers).expect(403);
      const res = await subir(ruta, reportante.headers).expect(200);
      expect((res.body as Cuerpo).photo_url).toContain(BUCKET_DE_PRUEBA);
      await http().delete(ruta).set(reportante.headers).expect(200);
      expect(
        (
          await dataSource
            .getRepository(Incident)
            .findOneByOrFail({ incidentId: incidencia.incidentId })
        ).photoKey,
      ).toBeNull();
    });

    it('el detalle y la edición firman la foto de S3 (no devuelven la externa)', async () => {
      const { d1, admin1 } = await escenario();
      const chofer = await seedChofer(d1.distributorId);
      const incidencia = await seedIncidencia(
        d1.distributorId,
        chofer.user.userId,
      );
      await subir(
        `/incidents/${incidencia.incidentId}/photo`,
        admin1.headers,
      ).expect(200);
      const detalle = await http()
        .get(`/incidents/${incidencia.incidentId}`)
        .set(admin1.headers)
        .expect(200);
      expect((detalle.body as Cuerpo).photo_url).toContain(BUCKET_DE_PRUEBA);
      const editada = await http()
        .patch(`/incidents/${incidencia.incidentId}`)
        .set(admin1.headers)
        .send({ description: 'Otra descripción' })
        .expect(200);
      expect((editada.body as Cuerpo).photo_url).toContain(BUCKET_DE_PRUEBA);
    });

    it('un chofer sólo ve la foto de las incidencias que él reportó en un pedido compartido', async () => {
      const { d1, admin1 } = await escenario();
      const mio = await seedChofer(d1.distributorId);
      const otro = await seedChofer(d1.distributorId);
      const propia = await seedIncidencia(d1.distributorId, mio.user.userId);
      const ajena = (await dataSource.getRepository(Incident).save({
        orderId: propia.orderId,
        distributorId: d1.distributorId,
        reportedBy: otro.user.userId,
        type: IncidentType.DAMAGED,
        description: 'Otra',
        photoUrl: FOTO_EXTERNA,
      } as Partial<Incident>)) as Incident;
      await subir(`/incidents/${propia.incidentId}/photo`, mio.headers).expect(
        200,
      );
      await subir(`/incidents/${ajena.incidentId}/photo`, otro.headers).expect(
        200,
      );
      const vistaDelChofer = await http()
        .get(`/incidents/order/${propia.orderId}`)
        .set(mio.headers)
        .expect(200);
      const filas = vistaDelChofer.body as Cuerpo[];
      expect(filas).toHaveLength(2);
      for (const f of filas) {
        if (f.incident_id === propia.incidentId) {
          expect(f.photo_url).toContain(BUCKET_DE_PRUEBA);
        } else {
          expect(f.photo_url).toBeNull();
        }
      }
      const vistaAdmin = await http()
        .get(`/incidents/order/${propia.orderId}`)
        .set(admin1.headers)
        .expect(200);
      for (const f of vistaAdmin.body as Cuerpo[]) {
        expect(f.photo_url).toContain(BUCKET_DE_PRUEBA);
      }
    });

    it('una incidencia resuelta o descartada no admite cambiar ni sacar la foto (409) y el objeto queda', async () => {
      const { d1, admin1 } = await escenario();
      const chofer = await seedChofer(d1.distributorId);
      for (const status of ['resolved', 'discarded']) {
        const incidencia = await seedIncidencia(
          d1.distributorId,
          chofer.user.userId,
        );
        const ruta = `/incidents/${incidencia.incidentId}/photo`;
        await subir(ruta, chofer.headers).expect(200);
        const key = (
          await dataSource
            .getRepository(Incident)
            .findOneByOrFail({ incidentId: incidencia.incidentId })
        ).photoKey as string;
        await http()
          .patch(`/incidents/${incidencia.incidentId}/resolve`)
          .set(admin1.headers)
          .send({ status, resolutionNote: 'cerrada' })
          .expect(200);
        await subir(ruta, admin1.headers, JPG, 'image/jpeg').expect(409);
        await http().delete(ruta).set(admin1.headers).expect(409);
        expect(
          (
            await dataSource
              .getRepository(Incident)
              .findOneByOrFail({ incidentId: incidencia.incidentId })
          ).photoKey,
        ).toBe(key);
        expect(await existe(key)).toBe(true);
      }
    });

    it('la foto subida manda sobre la photo_url externa, que queda como respaldo', async () => {
      const { d1, admin1 } = await escenario();
      const chofer = await seedChofer(d1.distributorId);
      const incidencia = await seedIncidencia(
        d1.distributorId,
        chofer.user.userId,
      );
      const ruta = `/incidents/${incidencia.incidentId}/photo`;
      await subir(ruta, admin1.headers).expect(200);
      const lista = await http()
        .get('/incidents')
        .set(admin1.headers)
        .expect(200);
      expect((lista.body as Cuerpo[])[0].photo_url).toContain(BUCKET_DE_PRUEBA);
      const porPedido = await http()
        .get(`/incidents/order/${incidencia.orderId}`)
        .set(admin1.headers)
        .expect(200);
      expect((porPedido.body as Cuerpo[])[0].photo_url).toContain(
        BUCKET_DE_PRUEBA,
      );
      await http().delete(ruta).set(admin1.headers).expect(200);
      expect(
        (
          (await http().get('/incidents').set(admin1.headers).expect(200))
            .body as Cuerpo[]
        )[0].photo_url,
      ).toBe(FOTO_EXTERNA);
    });
  });

  describe('logo de la distribuidora', () => {
    it('logo_url queda como texto de respaldo y el logo de S3 sale aparte en photoUrl', async () => {
      const d = await seedDistribuidora({
        logoUrl: 'https://viejo.example/logo.png',
      });
      const admin = await seedAdmin(d.distributorId);
      const ruta = `/distributor/${d.distributorId}/logo`;

      const actual = () =>
        http().get('/distributor/current').set(admin.headers).expect(200);
      expect(((await actual()).body as Cuerpo).logo_url).toBe(
        'https://viejo.example/logo.png',
      );
      const link = await http()
        .get(`${ruta}?modo=url`)
        .set(admin.headers)
        .expect(200);
      expect((link.body as Cuerpo).url).toBe('https://viejo.example/logo.png');

      expect(((await actual()).body as Cuerpo).photoUrl).toBeNull();
      await subir(ruta, admin.headers).expect(200);
      const conLogo = (await actual()).body as Cuerpo;
      expect(conLogo.photoUrl).toContain(BUCKET_DE_PRUEBA);
      // `logo_url` sigue siendo sólo el texto guardado: nunca la URL firmada.
      expect(conLogo.logo_url).toBe('https://viejo.example/logo.png');
      await http().delete(ruta).set(admin.headers).expect(200);
      const sinLogo = (await actual()).body as Cuerpo;
      expect(sinLogo.photoUrl).toBeNull();
      expect(sinLogo.logo_url).toBe('https://viejo.example/logo.png');
      // El texto libre nunca se pisó.
      expect(
        (
          await dataSource
            .getRepository(Distributor)
            .findOneByOrFail({ distributorId: d.distributorId })
        ).logoUrl,
      ).toBe('https://viejo.example/logo.png');
    });

    it('logo_url no acepta una URL firmada de S3 (vence) y no se guarda', async () => {
      const d = await seedDistribuidora({
        logoUrl: 'https://viejo.example/l.png',
      });
      const admin = await seedAdmin(d.distributorId);
      const superAdmin = await seedAdmin(null);
      await subir(`/distributor/${d.distributorId}/logo`, admin.headers).expect(
        200,
      );
      const actual = (
        await http().get('/distributor/current').set(admin.headers).expect(200)
      ).body as Cuerpo;
      const ruta = `/distributor/${d.distributorId}`;
      await http()
        .patch(ruta)
        .set(superAdmin.headers)
        .send({ logo_url: actual.photoUrl })
        .expect(400);
      await http()
        .patch(ruta)
        .set(superAdmin.headers)
        .send({ logo_url: 'https://nuevo.example/l.png', phone: '123' })
        .expect(200);
      expect(
        (
          await dataSource
            .getRepository(Distributor)
            .findOneByOrFail({ distributorId: d.distributorId })
        ).logoUrl,
      ).toBe('https://nuevo.example/l.png');
    });

    it('el super admin sube el de cualquiera, sin elegir distribuidora, y lo ve en el listado', async () => {
      const { d1, d2, superAdmin } = await escenario();
      await subir(
        `/distributor/${d1.distributorId}/logo`,
        superAdmin.headers,
      ).expect(200);
      await subir(
        `/distributor/${d2.distributorId}/logo`,
        superAdmin.headers,
      ).expect(200);
      const lista = await http()
        .get('/distributor')
        .set(superAdmin.headers)
        .expect(200);
      for (const d of lista.body as Cuerpo[]) {
        expect(d.photoUrl).toContain(BUCKET_DE_PRUEBA);
      }
    });
  });

  describe('listados con fotos', () => {
    it('el listado de vehículos firma la foto del vehículo y la de su chofer', async () => {
      const { d1, admin1 } = await escenario();
      const chofer = await seedChofer(d1.distributorId);
      const car = (await dataSource.getRepository(Car).save({
        distributorId: d1.distributorId,
        userId: chofer.user.userId,
        carPatent: `TST${randomUUID().slice(0, 6).toUpperCase()}`,
      } as Partial<Car>)) as Car;
      await subir(`/car/${car.carId}/photo`, admin1.headers).expect(200);
      await subir(`/users/${chofer.user.userId}/photo`, admin1.headers).expect(
        200,
      );
      const lista = await http().get('/car').set(admin1.headers).expect(200);
      const fila = (lista.body as Array<Cuerpo & { user: Cuerpo }>)[0];
      expect(fila.photoUrl).toContain(BUCKET_DE_PRUEBA);
      expect(fila.user.photoUrl).toContain(BUCKET_DE_PRUEBA);
    });
  });

  describe('imágenes de demostración', () => {
    it.each(['garrafa', 'camioneta', 'logo', 'aviso'] as const)(
      'el generador de "%s" produce un PNG que el back acepta',
      async (figura) => {
        const { d1, admin1 } = await escenario();
        const png = generarImagenDemo({ figura, variante: 2 });
        expect(png.subarray(0, 8).equals(PNG.subarray(0, 8))).toBe(true);
        expect(png.length).toBeLessThan(200 * 1024);
        const res = await subir(
          `/distributor/${d1.distributorId}/logo`,
          admin1.headers,
          png,
        ).expect(200);
        const url = (res.body as Cuerpo).photoUrl as string;
        const bajada = await fetch(url);
        expect(Buffer.from(await bajada.arrayBuffer()).equals(png)).toBe(true);
      },
    );
  });
});
