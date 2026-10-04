/**
 * Ciclo de adjuntos genéricos contra la API con Postgres real: subir ->
 * listar -> descargar -> borrar, el aislamiento entre distribuidoras, los
 * límites del archivo y lo que puede tocar un chofer. Los módulos dueños
 * todavía no existen: el test registra resolvers de ejemplo.
 */
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  truncateAllTables,
  telefonoDePrueba,
} from './setup/test-env';
import { AttachmentOwnerRegistry } from '../../src/attachment/attachment-owner.registry';
import {
  Attachment,
  AttachmentOwnerType,
} from '../../src/attachment/entities/attachment.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { Admin } from '../../src/admin/entities/admin.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';

interface Dueno {
  distributorId: string;
  userId?: string;
}

describe('Adjuntos genéricos (e2e)', () => {
  const storageDir = mkdtempSync(join(tmpdir(), 'splg-attachments-'));
  let env: TestEnv;
  let dataSource: DataSource;
  // El "dueño" de ejemplo: id -> a qué distribuidora (y a qué usuario) pertenece.
  const empleados = new Map<string, Dueno>();
  const cargas = new Map<string, Dueno>();

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_LOCAL_PATH = storageDir;
    env = await createTestApp();
    dataSource = env.app.get(DataSource);

    const registry = env.app.get(AttachmentOwnerRegistry);
    const asegurar = (mapa: Map<string, Dueno>) => (id: string, d: string) => {
      if (mapa.get(id)?.distributorId !== d) {
        return Promise.reject(new NotFoundException(`No existe ${id}`));
      }
      return Promise.resolve();
    };
    registry.register({
      ownerType: AttachmentOwnerType.EMPLOYEE,
      assertOwner: asegurar(empleados),
    });
    registry.register({
      ownerType: AttachmentOwnerType.FUEL_LOAD,
      assertOwner: asegurar(cargas),
      isOwnedByUser: (id, userId) =>
        Promise.resolve(cargas.get(id)?.userId === userId),
    });
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
    rmSync(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
    empleados.clear();
    cargas.clear();
  });

  async function rol(type: string): Promise<Role> {
    const roles = dataSource.getRepository(Role);
    return (
      (await roles.findOne({ where: { type } })) ??
      (await roles.save({ type } as Partial<Role>))
    );
  }

  async function seedDistribuidora() {
    const sufijo = randomUUID().slice(0, 8);
    return dataSource.getRepository(Distributor).save({
      name: `Distribuidora ${sufijo}`,
      slug: `dist-${sufijo}`,
    } as Partial<Distributor>);
  }

  async function seedUsuario(
    tipo: 'admin' | 'delivery',
    distributorId: string,
  ) {
    const sufijo = randomUUID().slice(0, 8);
    const email = `${tipo}.${sufijo}@splg.local`;
    const user = await dataSource.getRepository(User).save({
      email,
      fullName: `Test ${tipo}`,
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol(tipo)).roleId,
    } as Partial<User>);
    if (tipo === 'admin') {
      await dataSource
        .getRepository(Admin)
        .save({ userId: user.userId, distributorId } as Partial<Admin>);
    } else {
      await dataSource
        .getRepository(Delivery)
        .save({ userId: user.userId, distributorId } as Partial<Delivery>);
    }
    return {
      user,
      headers: {
        Authorization: `Bearer ${email}`,
        'X-Client-Source': tipo === 'admin' ? 'panel-app' : 'delivery-app',
      },
    };
  }

  const PDF = Buffer.from('%PDF-1.4 contenido de prueba');

  function subir(
    headers: Record<string, string>,
    tipo: string,
    id: string,
    over: {
      nombre?: string;
      mime?: string;
      buffer?: Buffer;
      label?: string;
    } = {},
  ) {
    const req = request(env.app.getHttpServer())
      .post(`/attachments/${tipo}/${id}`)
      .set(headers);
    if (over.label !== undefined) req.field('label', over.label);
    return req.attach('file', over.buffer ?? PDF, {
      filename: over.nombre ?? 'dni.pdf',
      contentType: over.mime ?? 'application/pdf',
    });
  }

  async function escenario() {
    const d1 = await seedDistribuidora();
    const d2 = await seedDistribuidora();
    const admin1 = await seedUsuario('admin', d1.distributorId);
    const admin2 = await seedUsuario('admin', d2.distributorId);
    const empleado = randomUUID();
    empleados.set(empleado, { distributorId: d1.distributorId });
    return { d1, d2, admin1, admin2, empleado };
  }

  it('ciclo completo: subir, listar, descargar y borrar', async () => {
    const { admin1, empleado } = await escenario();

    const creado = await subir(admin1.headers, 'employee', empleado, {
      nombre: 'póliza 2026.pdf',
      label: 'Póliza 2026',
    }).expect(201);
    expect(creado.body).toMatchObject({
      ownerType: 'employee',
      ownerId: empleado,
      label: 'Póliza 2026',
      originalName: 'póliza 2026.pdf',
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
      uploadedByUserId: admin1.user.userId,
    });
    expect(creado.body).not.toHaveProperty('storageKey');
    const id = (creado.body as { attachmentId: string }).attachmentId;

    const listado = await request(env.app.getHttpServer())
      .get(`/attachments/employee/${empleado}`)
      .set(admin1.headers)
      .expect(200);
    expect((listado.body as unknown[]).length).toBe(1);

    const descarga = await request(env.app.getHttpServer())
      .get(`/attachments/${id}/download`)
      .set(admin1.headers)
      .buffer(true)
      .parse((res, cb) => {
        const trozos: Buffer[] = [];
        res.on('data', (t: Buffer) => trozos.push(t));
        res.on('end', () => cb(null, Buffer.concat(trozos)));
      })
      .expect(200);
    expect(descarga.headers['content-type']).toContain('application/pdf');
    expect(descarga.headers['content-disposition']).toContain(
      "filename*=UTF-8''p%C3%B3liza%202026.pdf",
    );
    expect((descarga.body as Buffer).equals(PDF)).toBe(true);

    await request(env.app.getHttpServer())
      .delete(`/attachments/${id}`)
      .set(admin1.headers)
      .expect(204);
    await request(env.app.getHttpServer())
      .get(`/attachments/${id}/download`)
      .set(admin1.headers)
      .expect(404);
    expect(await dataSource.getRepository(Attachment).count()).toBe(0);
  });

  it('otra distribuidora no puede subir, listar, descargar ni borrar: 404', async () => {
    const { admin1, admin2, empleado } = await escenario();
    const creado = await subir(admin1.headers, 'employee', empleado).expect(
      201,
    );
    const id = (creado.body as { attachmentId: string }).attachmentId;

    await subir(admin2.headers, 'employee', empleado).expect(404);
    await request(env.app.getHttpServer())
      .get(`/attachments/employee/${empleado}`)
      .set(admin2.headers)
      .expect(404);
    await request(env.app.getHttpServer())
      .get(`/attachments/${id}/download`)
      .set(admin2.headers)
      .expect(404);
    await request(env.app.getHttpServer())
      .delete(`/attachments/${id}`)
      .set(admin2.headers)
      .expect(404);

    expect(await dataSource.getRepository(Attachment).count()).toBe(1);
  });

  it('un dueño inexistente es 404 y no deja nada guardado', async () => {
    const { admin1 } = await escenario();
    await subir(admin1.headers, 'employee', randomUUID()).expect(404);
    expect(await dataSource.getRepository(Attachment).count()).toBe(0);
  });

  it('un tipo sin resolver registrado es 400 claro', async () => {
    const { admin1 } = await escenario();
    const res = await subir(
      admin1.headers,
      'traffic_fine',
      randomUUID(),
    ).expect(400);
    expect(JSON.stringify(res.body)).toContain('traffic_fine');
  });

  it('un tipo que no existe es 400 y un id que no es uuid es 400', async () => {
    const { admin1, empleado } = await escenario();
    await subir(admin1.headers, 'marciano', empleado).expect(400);
    await subir(admin1.headers, 'employee', 'no-es-uuid').expect(400);
  });

  it('rechaza mime no permitido (415), más de 10 MB (413) y falta de archivo (400)', async () => {
    const { admin1, empleado } = await escenario();
    await subir(admin1.headers, 'employee', empleado, {
      mime: 'application/msword',
      nombre: 'a.doc',
    }).expect(415);
    await subir(admin1.headers, 'employee', empleado, {
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
    }).expect(413);
    await request(env.app.getHttpServer())
      .post(`/attachments/employee/${empleado}`)
      .set(admin1.headers)
      .expect(400);
    expect(await dataSource.getRepository(Attachment).count()).toBe(0);
  });

  it('la subida queda en la auditoría', async () => {
    const { admin1, empleado } = await escenario();
    await subir(admin1.headers, 'employee', empleado).expect(201);
    // El asiento se guarda sin demorar la respuesta.
    let filas: Array<{ resource: string; result: string }> = [];
    for (let i = 0; i < 20 && filas.length === 0; i++) {
      filas = await dataSource.query(
        `SELECT resource, result FROM audit_log WHERE resource = 'attachments'`,
      );
      if (filas.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(filas[0]).toMatchObject({
      resource: 'attachments',
      result: 'success',
    });
  });

  it('el contenido tiene que coincidir con el tipo declarado: un HTML como image/png es 415', async () => {
    const { admin1, empleado } = await escenario();
    await subir(admin1.headers, 'employee', empleado, {
      mime: 'image/png',
      nombre: 'x.png',
      buffer: Buffer.from('<html><script>alert(1)</script></html>'),
    }).expect(415);
    expect(await dataSource.getRepository(Attachment).count()).toBe(0);
  });

  it('un nombre larguísimo se recorta y no rompe (nunca 500)', async () => {
    const { admin1, empleado } = await escenario();
    const res = await subir(admin1.headers, 'employee', empleado, {
      nombre: `${'n'.repeat(400)}.pdf`,
    }).expect(201);
    const nombre = (res.body as { originalName: string }).originalName;
    expect(nombre).toHaveLength(255);
    expect(nombre.endsWith('.pdf')).toBe(true);
  });

  it('el nombre con apóstrofe y paréntesis sale bien codificado en la descarga', async () => {
    const { admin1, empleado } = await escenario();
    const creado = await subir(admin1.headers, 'employee', empleado, {
      nombre: "o'brien (1).pdf",
    }).expect(201);
    const id = (creado.body as { attachmentId: string }).attachmentId;
    const res = await request(env.app.getHttpServer())
      .get(`/attachments/${id}/download`)
      .set(admin1.headers)
      .expect(200);
    expect(res.headers['content-disposition']).toContain(
      "filename*=UTF-8''o%27brien%20%281%29.pdf",
    );
  });

  it('con el dueño borrado el admin igual puede bajar y borrar el adjunto', async () => {
    const { admin1, empleado } = await escenario();
    const creado = await subir(admin1.headers, 'employee', empleado).expect(
      201,
    );
    const id = (creado.body as { attachmentId: string }).attachmentId;

    empleados.delete(empleado); // el resolver deja de encontrarlo
    await request(env.app.getHttpServer())
      .get(`/attachments/employee/${empleado}`)
      .set(admin1.headers)
      .expect(404);
    await request(env.app.getHttpServer())
      .get(`/attachments/${id}/download`)
      .set(admin1.headers)
      .expect(200);
    await request(env.app.getHttpServer())
      .delete(`/attachments/${id}`)
      .set(admin1.headers)
      .expect(204);
  });

  it('si el archivo falta en el storage, la descarga responde 404 y el proceso sigue vivo', async () => {
    const { admin1, empleado } = await escenario();
    const creado = await subir(admin1.headers, 'employee', empleado).expect(
      201,
    );
    const id = (creado.body as { attachmentId: string }).attachmentId;
    rmSync(storageDir, { recursive: true, force: true });

    await request(env.app.getHttpServer())
      .get(`/attachments/${id}/download`)
      .set(admin1.headers)
      .expect(404);
    await request(env.app.getHttpServer())
      .get(`/attachments/employee/${empleado}`)
      .set(admin1.headers)
      .expect(200);
  });

  describe('chofer', () => {
    it('accede a los adjuntos de su carga, no a los de otro chofer ni a legajos', async () => {
      const { d1, admin1, empleado } = await escenario();
      const chofer = await seedUsuario('delivery', d1.distributorId);
      const otro = await seedUsuario('delivery', d1.distributorId);
      const suya = randomUUID();
      const ajena = randomUUID();
      cargas.set(suya, {
        distributorId: d1.distributorId,
        userId: chofer.user.userId,
      });
      cargas.set(ajena, {
        distributorId: d1.distributorId,
        userId: otro.user.userId,
      });

      const creado = await subir(chofer.headers, 'fuel_load', suya).expect(201);
      const id = (creado.body as { attachmentId: string }).attachmentId;
      await request(env.app.getHttpServer())
        .get(`/attachments/fuel_load/${suya}`)
        .set(chofer.headers)
        .expect(200);

      await subir(chofer.headers, 'fuel_load', ajena).expect(404);
      await request(env.app.getHttpServer())
        .get(`/attachments/${id}/download`)
        .set(otro.headers)
        .expect(404);
      await request(env.app.getHttpServer())
        .delete(`/attachments/${id}`)
        .set(otro.headers)
        .expect(404);
      await subir(chofer.headers, 'employee', empleado).expect(403);

      // El admin ve el adjunto del chofer; el chofer sólo borra lo suyo.
      await request(env.app.getHttpServer())
        .get(`/attachments/fuel_load/${suya}`)
        .set(admin1.headers)
        .expect(200);
      await request(env.app.getHttpServer())
        .delete(`/attachments/${id}`)
        .set(chofer.headers)
        .expect(204);
    });
  });
});
