/**
 * Baja del administrador de una distribuidora dada de baja, contra la app con
 * Postgres y Redis efímeros: el super admin, sin `X-Distributor`, da de baja a
 * su último administrador (sin la regla de «que quede otro»); la regla sigue
 * para una distribuidora vigente; un admin de otra distribuidora es 404 y uno
 * ya dado de baja también, en GET, PATCH y DELETE.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { TestEnv, createTestApp } from './setup/test-env';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { MENSAJE_FALTA_DISTRIBUIDORA } from '../../src/common/decorators/current-distributor.decorator';
import {
  Escenario,
  sembrarEscenario,
  sembrarPersona,
} from './matriz-http/matriz';

describe('Baja del administrador de una distribuidora eliminada (e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let e: Escenario;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    e = await sembrarEscenario(env.app);
  }, 240000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const http = () => request(env.app.getHttpServer());
  const adminIdDe = async (userId: string): Promise<string> => {
    const [fila] = await ds.query<Array<{ admin_id: string }>>(
      `SELECT admin_id FROM admin WHERE user_id = $1`,
      [userId],
    );
    return fila.admin_id;
  };
  const usuarioDadoDeBaja = async (userId: string): Promise<boolean> => {
    const [fila] = await ds.query<Array<{ baja: boolean }>>(
      `SELECT "deletedAt" IS NOT NULL AS baja FROM "user" WHERE user_id = $1`,
      [userId],
    );
    return fila.baja;
  };

  let seq = 0;

  /** Una distribuidora nueva con un único admin, dada de baja por la API. */
  async function distribuidoraEliminadaConSuAdmin() {
    seq += 1;
    const nueva = await ds.getRepository(Distributor).save({
      name: `Eliminada ${seq} ${randomUUID().slice(0, 6)}`,
      slug: `eliminada-${seq}-${randomUUID().slice(0, 6)}`,
    } as Partial<Distributor>);
    const distributorId = nueva.distributorId;
    const admin = await sembrarPersona(
      env.app,
      'admin',
      'admin-eliminada',
      distributorId,
    );
    await http()
      .delete(`/distributor/${distributorId}`)
      .set(e.actores.super)
      .expect(200);
    const [d] = await ds.query<Array<{ baja: boolean }>>(
      `SELECT "deletedAt" IS NOT NULL AS baja FROM distributor WHERE distributor_id = $1`,
      [distributorId],
    );
    expect(d.baja).toBe(true);
    return {
      distributorId,
      admin: { ...admin, adminId: await adminIdDe(admin.userId) },
    };
  }

  it('super admin sin X-Distributor da de baja al último admin de una distribuidora eliminada: 200', async () => {
    const { admin } = await distribuidoraEliminadaConSuAdmin();

    const res = await http()
      .delete(`/admin/${admin.adminId}`)
      .set(e.actores.super)
      .expect(200);
    expect((res.body as { message: string }).message).toBe(
      'Usuario dado de baja',
    );
    expect(await usuarioDadoDeBaja(admin.userId)).toBe(true);
  });

  it('ya dado de baja: GET, PATCH y DELETE responden 404 «Administrador no encontrado»', async () => {
    const { admin } = await distribuidoraEliminadaConSuAdmin();
    await http()
      .delete(`/admin/${admin.adminId}`)
      .set(e.actores.super)
      .expect(200);

    for (const llamada of [
      () => http().get(`/admin/${admin.adminId}`).set(e.actores.super),
      () =>
        http()
          .patch(`/admin/${admin.adminId}`)
          .set(e.actores.super)
          .send({ fullName: 'Otro nombre' }),
      () => http().delete(`/admin/${admin.adminId}`).set(e.actores.super),
    ]) {
      const res = await llamada().expect(404);
      expect((res.body as { message: string }).message).toBe(
        'Administrador no encontrado',
      );
    }
  });

  it('editarlo sin X-Distributor sigue pidiendo la distribuidora (400): la excepción es sólo la baja', async () => {
    const { admin } = await distribuidoraEliminadaConSuAdmin();
    const res = await http()
      .patch(`/admin/${admin.adminId}`)
      .set(e.actores.super)
      .send({ fullName: 'Otro nombre' })
      .expect(400);
    expect((res.body as { message: string }).message).toBe(
      MENSAJE_FALTA_DISTRIBUIDORA,
    );
    expect(await usuarioDadoDeBaja(admin.userId)).toBe(false);
  });

  it('con X-Distributor de la distribuidora eliminada el guard responde 401', async () => {
    const { distributorId, admin } = await distribuidoraEliminadaConSuAdmin();
    await http()
      .delete(`/admin/${admin.adminId}`)
      .set({ ...e.actores.super, 'X-Distributor': distributorId })
      .expect(401);
    expect(await usuarioDadoDeBaja(admin.userId)).toBe(false);
  });

  it('el admin de una distribuidora eliminada visto desde otra distribuidora: 404', async () => {
    const { admin } = await distribuidoraEliminadaConSuAdmin();
    await http()
      .delete(`/admin/${admin.adminId}`)
      .set(e.actores.superEnA)
      .expect(404);
    await http()
      .delete(`/admin/${admin.adminId}`)
      .set(e.actores.adminA)
      .expect(404);
    expect(await usuarioDadoDeBaja(admin.userId)).toBe(false);
  });

  it('un admin de otra distribuidora (vigente) sigue con 404', async () => {
    await http()
      .delete(`/admin/${e.adminB.adminId}`)
      .set(e.actores.superEnA)
      .expect(404);
    await http()
      .delete(`/admin/${e.adminB.adminId}`)
      .set(e.actores.adminA)
      .expect(404);
  });

  it('distribuidora vigente: sin X-Distributor es 400 y con ella el último admin sigue protegido (409)', async () => {
    const res = await http()
      .delete(`/admin/${e.adminB.adminId}`)
      .set(e.actores.super)
      .expect(400);
    expect((res.body as { message: string }).message).toBe(
      MENSAJE_FALTA_DISTRIBUIDORA,
    );
    await http()
      .delete(`/admin/${e.adminB.adminId}`)
      .set({ ...e.actores.super, 'X-Distributor': e.distB.slug })
      .expect(409);
    expect(await usuarioDadoDeBaja(e.adminB.userId)).toBe(false);
  });
});
