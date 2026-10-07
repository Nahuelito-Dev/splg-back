/**
 * S3 REAL (MinIO en un contenedor efímero), sin mocks del SDK: `S3Service` por
 * sí solo y los flujos HTTP de punta a punta (adjunto genérico y foto del
 * reclamo, CU-174/175).
 */
import { randomUUID } from 'crypto';
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  sembrarClienteAutenticado,
  truncateAllTables,
  telefonoDePrueba,
} from './setup/test-env';
import { BUCKET_DE_PRUEBA, TestMinio, startMinio } from './setup/minio';
import { S3Service } from '../../src/s3/s3.service';
import {
  Employee,
  EmployeeDocumentType,
  EmploymentType,
} from '../../src/employee/entities/employee.entity';
import {
  JobPosition,
  JobPositionCategory,
} from '../../src/employee/entities/job-position.entity';
import { Attachment } from '../../src/attachment/entities/attachment.entity';
import { Claim } from '../../src/claims/entities/claim.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { Admin } from '../../src/admin/entities/admin.entity';
import { S3CleanupService } from '../../src/s3/s3-cleanup.service';
import { StorageOrphan } from '../../src/s3/entities/storage-orphan.entity';
import { ReintentosDeHuerfanosDeStorage1791070100000 } from '../../src/migrations/1791070100000-ReintentosDeHuerfanosDeStorage';
import { FotoDeReclamoYHuerfanosDeStorage1791070000000 } from '../../src/migrations/1791070000000-FotoDeReclamoYHuerfanosDeStorage';

const PDF = Buffer.from('%PDF-1.4 contenido de prueba en S3');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('foto de prueba'),
]);
const JPG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('otra foto'),
]);

/** Espera (hasta ~5 s) a que se cumpla algo que ocurre en segundo plano. */
async function esperar(condicion: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (await condicion()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe('S3 contra MinIO (e2e)', () => {
  let minio: TestMinio;
  let env: TestEnv;
  let dataSource: DataSource;

  beforeAll(async () => {
    minio = await startMinio();
    env = await createTestApp({ s3: minio.env });
    dataSource = env.app.get(DataSource);
  }, 240000);

  afterAll(async () => {
    await env?.cleanup();
    await minio?.stop();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  /** Un legajo real: el dueño `employee` de los adjuntos lo resuelve el módulo Personal. */
  async function crearDueno(distributorId: string): Promise<string> {
    const puesto = await dataSource.getRepository(JobPosition).save({
      distributorId,
      name: 'Puesto de prueba',
      category: JobPositionCategory.OTHER,
    } as Partial<JobPosition>);
    const empleado = await dataSource.getRepository(Employee).save({
      distributorId,
      positionId: puesto.positionId,
      fileNumber: '0001',
      firstName: 'Ana',
      lastName: 'Pérez',
      documentType: EmployeeDocumentType.DNI,
      documentNumber: randomUUID().slice(0, 8),
      hireDate: '2026-03-01',
      employmentType: EmploymentType.PERMANENT,
    } as Partial<Employee>);
    return empleado.employeeId;
  }

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

  describe('adapter', () => {
    const adapter = () =>
      new S3Service({
        getOrThrow: (k: string) => minio.env[k],
        get: (k: string, def?: unknown) => minio.env[k] ?? def,
      } as unknown as ConfigService);

    it('put -> URL firmada -> GET con su Content-Type y Content-Disposition -> remove -> 404', async () => {
      const s3 = adapter();
      const key = `it/${randomUUID()}.pdf`;
      await s3.put({ key, body: PDF, contentType: 'application/pdf' });

      const head = await minio.client.send(
        new HeadObjectCommand({ Bucket: BUCKET_DE_PRUEBA, Key: key }),
      );
      expect(head.ServerSideEncryption).toBe('AES256');

      const firmada = await s3.getSignedDownload(key, {
        fileName: 'póliza 2026.pdf',
      });
      expect(firmada).not.toBeNull();
      expect(firmada.expiresAt.getTime()).toBeGreaterThan(Date.now());
      const res = await fetch(firmada.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('content-disposition')).toContain(
        "filename*=UTF-8''p%C3%B3liza%202026.pdf",
      );
      expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);

      await s3.remove(key);
      expect((await fetch(firmada.url)).status).toBe(404);
      // Borrar algo que ya no está no falla (idempotente).
      await expect(s3.remove(key)).resolves.toBeUndefined();
    });

    it('una URL firmada vencida deja de servir', async () => {
      const s3 = new S3Service({
        getOrThrow: (k: string) => minio.env[k],
        get: (k: string, def?: unknown) =>
          k === 'AWS_S3_SIGNED_URL_TTL_SECONDS' ? 1 : (minio.env[k] ?? def),
      } as unknown as ConfigService);
      const key = `it/${randomUUID()}.pdf`;
      await s3.put({ key, body: PDF, contentType: 'application/pdf' });
      const firmada = await s3.getSignedDownload(key);
      expect((await fetch(firmada.url)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 2500));
      expect((await fetch(firmada.url)).status).toBe(403);
      await s3.remove(key);
    });

    it('el bucket es privado: sin firma no se lee', async () => {
      const s3 = adapter();
      const key = `it/${randomUUID()}.pdf`;
      await s3.put({ key, body: PDF, contentType: 'application/pdf' });
      const directa = `${minio.endpoint}/${BUCKET_DE_PRUEBA}/${key}`;
      expect((await fetch(directa)).status).toBe(403);
      await s3.remove(key);
    });
  });

  async function rol(type: string): Promise<Role> {
    const roles = dataSource.getRepository(Role);
    return (
      (await roles.findOne({ where: { type } })) ??
      (await roles.save({ type } as Partial<Role>))
    );
  }

  async function seedAdmin(distributorId: string) {
    const sufijo = randomUUID().slice(0, 8);
    const email = `admin.${sufijo}@splg.local`;
    const user = await dataSource.getRepository(User).save({
      email,
      fullName: 'Test admin',
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol('admin')).roleId,
    } as Partial<User>);
    await dataSource
      .getRepository(Admin)
      .save({ userId: user.userId, distributorId } as Partial<Admin>);
    return {
      user,
      headers: {
        Authorization: `Bearer ${email}`,
        'X-Client-Source': 'panel-app',
      },
    };
  }

  async function seedDistribuidora() {
    const sufijo = randomUUID().slice(0, 8);
    return dataSource.getRepository(Distributor).save({
      name: `Distribuidora ${sufijo}`,
      slug: `dist-${sufijo}`,
    } as Partial<Distributor>);
  }

  describe('adjunto genérico', () => {
    it('subir -> modo=url -> descargar con la URL firmada -> 302 -> borrar es lógico y deja el objeto en el bucket', async () => {
      const d1 = await seedDistribuidora();
      const admin = await seedAdmin(d1.distributorId);
      const dueno = await crearDueno(d1.distributorId);

      const creado = await request(env.app.getHttpServer())
        .post(`/attachments/employee/${dueno}`)
        .set(admin.headers)
        .attach('file', PDF, {
          filename: 'póliza 2026.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      const id = (creado.body as { attachmentId: string }).attachmentId;
      const fila = await dataSource
        .getRepository(Attachment)
        .findOneByOrFail({ attachmentId: id });
      expect(await existe(fila.storageKey)).toBe(true);

      const enlace = await request(env.app.getHttpServer())
        .get(`/attachments/${id}/download?modo=url`)
        .set(admin.headers)
        .expect(200);
      const link = enlace.body as {
        url: string;
        expiresAt: string;
        requiresAuth: boolean;
      };
      expect(link.requiresAuth).toBe(false);
      expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now());
      const archivo = await fetch(link.url);
      expect(archivo.status).toBe(200);
      expect(archivo.headers.get('content-type')).toBe('application/pdf');
      expect(archivo.headers.get('content-disposition')).toContain(
        "filename*=UTF-8''p%C3%B3liza%202026.pdf",
      );
      expect(Buffer.from(await archivo.arrayBuffer()).equals(PDF)).toBe(true);

      // El modo por defecto sigue siendo el redirect de siempre.
      const redirect = await request(env.app.getHttpServer())
        .get(`/attachments/${id}/download`)
        .set(admin.headers)
        .redirects(0)
        .expect(302);
      expect(redirect.headers.location).toContain(BUCKET_DE_PRUEBA);

      await request(env.app.getHttpServer())
        .get(`/attachments/${id}/download?modo=otro`)
        .set(admin.headers)
        .expect(400);

      await request(env.app.getHttpServer())
        .delete(`/attachments/${id}`)
        .set(admin.headers)
        .expect(204);
      // Baja lógica: ya no se baja por la API, pero el objeto queda de respaldo.
      await request(env.app.getHttpServer())
        .get(`/attachments/${id}/download?modo=url`)
        .set(admin.headers)
        .expect(404);
      expect(await existe(fila.storageKey)).toBe(true);
    });

    it('otra distribuidora no obtiene la URL firmada (404)', async () => {
      const d1 = await seedDistribuidora();
      const d2 = await seedDistribuidora();
      const admin1 = await seedAdmin(d1.distributorId);
      const admin2 = await seedAdmin(d2.distributorId);
      const dueno = await crearDueno(d1.distributorId);
      const creado = await request(env.app.getHttpServer())
        .post(`/attachments/employee/${dueno}`)
        .set(admin1.headers)
        .attach('file', PDF, {
          filename: 'a.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      const id = (creado.body as { attachmentId: string }).attachmentId;
      await request(env.app.getHttpServer())
        .get(`/attachments/${id}/download?modo=url`)
        .set(admin2.headers)
        .expect(404);
    });
  });

  describe('foto del reclamo (CU-174 / CU-175)', () => {
    const FOTO_EXTERNA = 'https://externa.example/foto-vieja.jpg';

    async function escenario(photoUrl: string | null = FOTO_EXTERNA) {
      const { user, distributor, headers } = await sembrarClienteAutenticado(
        env.app,
      );
      const admin = await seedAdmin(distributor.distributorId);
      const address = (await dataSource.getRepository(UserAddress).save({
        userId: user.userId,
        street: 'Av. Test 123',
        city: 'CABA',
        latitude: '-34.6037',
        longitude: '-58.3816',
      } as Partial<UserAddress>)) as UserAddress;
      const pedido = (await dataSource.getRepository(Order).save({
        distributorId: distributor.distributorId,
        customerId: user.userId,
        addressId: address.addressId,
        status: OrderStatus.DELIVERED,
        paymentMethod: PaymentMethod.CASH,
        subtotalItems: 1000,
        totalAmount: 1000,
      } as Partial<Order>)) as Order;
      const reclamo = (await dataSource.getRepository(Claim).save({
        distributorId: distributor.distributorId,
        orderId: pedido.orderId,
        customerId: user.userId,
        reason: 'Fuga',
        description: 'Huele a gas',
        photoUrl,
      } as Partial<Claim>)) as Claim;
      return { user, distributor, headers, admin, reclamo };
    }

    const subir = (
      headers: Record<string, string>,
      id: string,
      buffer: Buffer,
      mime: string,
    ) =>
      request(env.app.getHttpServer())
        .post(`/claims/${id}/photo`)
        .set(headers)
        .attach('file', buffer, { filename: 'foto', contentType: mime });

    it('un reclamo sin ninguna foto: modo=url es 200 con url null y el archivo es 404; el ajeno sigue en 404', async () => {
      const { headers, reclamo } = await escenario(null);
      const enlace = await request(env.app.getHttpServer())
        .get(`/claims/${reclamo.claimId}/photo?modo=url`)
        .set(headers)
        .expect(200);
      expect(enlace.body).toEqual({
        url: null,
        expiresAt: null,
        requiresAuth: false,
      });
      await request(env.app.getHttpServer())
        .get(`/claims/${reclamo.claimId}/photo`)
        .set(headers)
        .expect(404);
      const otro = await sembrarClienteAutenticado(env.app);
      await request(env.app.getHttpServer())
        .get(`/claims/${reclamo.claimId}/photo?modo=url`)
        .set(otro.headers)
        .expect(404);
    });

    it('el cliente sube la foto, la ve por URL firmada y al reemplazarla se borra la anterior', async () => {
      const { distributor, headers, admin, reclamo } = await escenario();

      // Antes de subir, `photoUrl` sigue siendo la URL externa que traía.
      const antes = await request(env.app.getHttpServer())
        .get('/claims')
        .set(admin.headers)
        .expect(200);
      expect((antes.body as Array<{ photoUrl: string }>)[0].photoUrl).toBe(
        'https://externa.example/foto-vieja.jpg',
      );
      // Sin `photoKey` pero con la URL externa: el enlace y el archivo son esa URL.
      const externa = await request(env.app.getHttpServer())
        .get(`/claims/${reclamo.claimId}/photo?modo=url`)
        .set(headers)
        .expect(200);
      expect(externa.body).toEqual({
        url: FOTO_EXTERNA,
        expiresAt: null,
        requiresAuth: false,
      });
      const redirigida = await request(env.app.getHttpServer())
        .get(`/claims/${reclamo.claimId}/photo`)
        .set(headers)
        .expect(302);
      expect(redirigida.headers.location).toBe(FOTO_EXTERNA);

      const primera = await subir(
        headers,
        reclamo.claimId,
        PNG,
        'image/png',
      ).expect(201);
      const dto = primera.body as { claim_id: string; photoUrl: string };
      expect(dto.claim_id).toBe(reclamo.claimId);
      expect(dto.photoUrl).toContain(BUCKET_DE_PRUEBA);
      const key1 = (
        await dataSource
          .getRepository(Claim)
          .findOneByOrFail({ claimId: reclamo.claimId })
      ).photoKey;
      expect(key1).toMatch(
        new RegExp(
          `^claims/${distributor.distributorId}/${reclamo.claimId}/[0-9a-f-]{36}\\.png$`,
        ),
      );
      expect(await existe(key1!)).toBe(true);
      // Se guarda cifrada y con su Content-Type.
      const head = await minio.client.send(
        new HeadObjectCommand({ Bucket: BUCKET_DE_PRUEBA, Key: key1! }),
      );
      expect(head.ServerSideEncryption).toBe('AES256');
      expect(head.ContentType).toBe('image/png');

      for (const quien of [headers, admin.headers]) {
        const ver = await request(env.app.getHttpServer())
          .get(`/claims/${reclamo.claimId}/photo?modo=url`)
          .set(quien)
          .expect(200);
        const link = ver.body as { url: string; requiresAuth: boolean };
        expect(link.requiresAuth).toBe(false);
        const res = await fetch(link.url);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/png');
        expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
      }

      const listado = await request(env.app.getHttpServer())
        .get('/claims')
        .set(admin.headers)
        .expect(200);
      const enLista = (listado.body as Array<{ photoUrl: string }>)[0].photoUrl;
      expect((await fetch(enLista)).status).toBe(200);

      const archivo = await request(env.app.getHttpServer())
        .get(`/claims/${reclamo.claimId}/photo`)
        .set(headers)
        .redirects(0)
        .expect(302);
      expect(archivo.headers.location).toContain(BUCKET_DE_PRUEBA);

      // Reemplazo: queda sólo la foto nueva.
      await subir(headers, reclamo.claimId, JPG, 'image/jpeg').expect(201);
      const key2 = (
        await dataSource
          .getRepository(Claim)
          .findOneByOrFail({ claimId: reclamo.claimId })
      ).photoKey;
      expect(key2).not.toBe(key1);
      expect(key2).toMatch(/\.jpg$/);
      expect(await esperar(async () => !(await existe(key1!)))).toBe(true);
      expect(await claves(`claims/${distributor.distributorId}/`)).toEqual([
        key2,
      ]);
    });

    it('rechaza lo que no es una imagen y no deja nada en el bucket', async () => {
      const { headers, reclamo, distributor } = await escenario();
      await subir(
        headers,
        reclamo.claimId,
        Buffer.from('<html><script>alert(1)</script></html>'),
        'image/png',
      ).expect(415);
      await subir(headers, reclamo.claimId, PDF, 'application/pdf').expect(415);
      await subir(
        headers,
        reclamo.claimId,
        Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]),
        'image/png',
      ).expect(413);
      await request(env.app.getHttpServer())
        .post(`/claims/${reclamo.claimId}/photo`)
        .set(headers)
        .expect(400);
      expect(await claves(`claims/${distributor.distributorId}/`)).toEqual([]);
    });

    it('otro cliente y el admin de otra distribuidora reciben 404', async () => {
      const { headers, reclamo } = await escenario();
      await subir(headers, reclamo.claimId, PNG, 'image/png').expect(201);

      const ajeno = await sembrarClienteAutenticado(env.app);
      const adminAjeno = await seedAdmin(ajeno.distributor.distributorId);
      for (const quien of [ajeno.headers, adminAjeno.headers]) {
        await subir(quien, reclamo.claimId, PNG, 'image/png').expect(404);
        await request(env.app.getHttpServer())
          .get(`/claims/${reclamo.claimId}/photo`)
          .set(quien)
          .expect(404);
        await request(env.app.getHttpServer())
          .get(`/claims/${reclamo.claimId}/photo?modo=url`)
          .set(quien)
          .expect(404);
      }
    });

    it('el admin de la distribuidora también puede subir la foto', async () => {
      const { admin, reclamo } = await escenario();
      await subir(admin.headers, reclamo.claimId, PNG, 'image/png').expect(201);
    });

    it('un reclamo resuelto no admite cambiar la foto (409) pero se sigue viendo', async () => {
      const { headers, admin, reclamo, distributor } = await escenario();
      await subir(headers, reclamo.claimId, PNG, 'image/png').expect(201);
      await request(env.app.getHttpServer())
        .patch(`/claims/${reclamo.claimId}/resolve`)
        .set(admin.headers)
        .send({ resolution: 'Listo', status: 'resolved' })
        .expect(200);
      await subir(headers, reclamo.claimId, JPG, 'image/jpeg').expect(409);
      await request(env.app.getHttpServer())
        .get(`/claims/${reclamo.claimId}/photo?modo=url`)
        .set(headers)
        .expect(200);
      expect(await claves(`claims/${distributor.distributorId}/`)).toHaveLength(
        1,
      );
    });

    it('dos subidas simultáneas se serializan: queda una sola foto en el bucket y ninguna fila pendiente', async () => {
      const { headers, reclamo, distributor } = await escenario();
      const respuestas = await Promise.all([
        subir(headers, reclamo.claimId, PNG, 'image/png'),
        subir(headers, reclamo.claimId, JPG, 'image/jpeg'),
      ]);
      expect(respuestas.map((r) => r.status)).toEqual([201, 201]);
      const key = (
        await dataSource
          .getRepository(Claim)
          .findOneByOrFail({ claimId: reclamo.claimId })
      ).photoKey;
      expect(
        await esperar(
          async () =>
            (await claves(`claims/${distributor.distributorId}/`)).length === 1,
        ),
      ).toBe(true);
      expect(await claves(`claims/${distributor.distributorId}/`)).toEqual([
        key,
      ]);
      expect(
        await esperar(
          async () =>
            (await dataSource.getRepository(StorageOrphan).count()) === 0,
        ),
      ).toBe(true);
    });
  });

  describe('huérfanos', () => {
    it('una subida abandonada (reservada, sin referencia) la barre el cron pasada la gracia', async () => {
      const key = `claims/abandonada/${randomUUID()}.png`;
      const cleanup = env.app.get(S3CleanupService);
      await cleanup.reserveUpload(key);
      await minio.client.send(
        new PutObjectCommand({ Bucket: BUCKET_DE_PRUEBA, Key: key, Body: PNG }),
      );

      // Dentro de la gracia no se toca.
      await cleanup.retryOrphans();
      expect(await existe(key)).toBe(true);

      await dataSource
        .getRepository(StorageOrphan)
        .update({ storageKey: key }, { nextAttemptAt: new Date(0) });
      await cleanup.retryOrphans();
      expect(await existe(key)).toBe(false);
      expect(
        await dataSource.getRepository(StorageOrphan).count({
          where: { storageKey: key },
        }),
      ).toBe(0);
    });

    it('subir y borrar un adjunto no deja filas pendientes', async () => {
      const d1 = await seedDistribuidora();
      const admin = await seedAdmin(d1.distributorId);
      const dueno = await crearDueno(d1.distributorId);
      const creado = await request(env.app.getHttpServer())
        .post(`/attachments/employee/${dueno}`)
        .set(admin.headers)
        .attach('file', PDF, {
          filename: 'a.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      expect(await dataSource.getRepository(StorageOrphan).count()).toBe(0);
      await request(env.app.getHttpServer())
        .delete(
          `/attachments/${(creado.body as { attachmentId: string }).attachmentId}`,
        )
        .set(admin.headers)
        .expect(204);
      expect(
        await esperar(
          async () =>
            (await dataSource.getRepository(StorageOrphan).count()) === 0,
        ),
      ).toBe(true);
    });
  });

  describe('migraciones de foto de reclamo y huérfanos', () => {
    it('bajan y suben sin perder el esquema', async () => {
      const foto = new FotoDeReclamoYHuerfanosDeStorage1791070000000();
      const reintentos = new ReintentosDeHuerfanosDeStorage1791070100000();
      const qr = dataSource.createQueryRunner();
      const tieneColumna = async (tabla: string, col: string) =>
        (
          (await qr.query(
            `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
            [tabla, col],
          )) as unknown[]
        ).length === 1;
      try {
        await reintentos.down(qr);
        expect(await tieneColumna('storage_orphan', 'next_attempt_at')).toBe(
          false,
        );
        await foto.down(qr);
        expect(await tieneColumna('claims', 'photo_key')).toBe(false);
        await foto.up(qr);
        await reintentos.up(qr);
        expect(await tieneColumna('claims', 'photo_key')).toBe(true);
        expect(await tieneColumna('storage_orphan', 'next_attempt_at')).toBe(
          true,
        );
        await qr.query(
          `INSERT INTO "storage_orphan" ("storage_key") VALUES ('k')`,
        );
      } finally {
        await qr.release();
      }
    });
  });
});
