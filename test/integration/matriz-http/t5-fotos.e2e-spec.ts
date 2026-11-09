import request from 'supertest';
import { DataSource } from 'typeorm';
import { TruckLoad } from '../../../src/truck-load/entities/truck-load.entity';
import { startMinio, TestMinio } from '../setup/minio';
import { PNG_REAL } from '../setup/imagenes';
import { createTestApp, TestEnv } from '../setup/test-env';
import { Adjunto, Caso, correrMatriz, endpoint, llamar } from './matriz';
import {
  ADMIN_O_CHOFER,
  EscenarioT5,
  SOLO_ADMIN,
  bordes,
  comoChofer,
  sembrarBaseT5,
  sembrarCarga,
  sinCambios,
} from './t5-base';

type C = EscenarioT5;
const ADMIN = 'adminA';

const carga =
  (dist: 'A' | 'B' = 'A') =>
  async (c: C) => {
    const r = await sembrarCarga(c, { dist });
    c.p.carga = r.loadId;
    c.ch.c = r.chofer;
  };
const conFoto =
  (dist: 'A' | 'B' = 'A') =>
  async (c: C) => {
    await carga(dist)(c);
    const res = await llamar(
      c,
      'put',
      `/v2/truck-loads/${c.p.carga}/photo`,
      dist === 'B' ? 'adminB' : ADMIN,
      undefined,
      adjunto(),
    );
    if (res.status !== 200) {
      throw new Error(`No se pudo subir la foto (${res.status})`);
    }
  };
const adjunto = (extra: Partial<Adjunto> = {}): Adjunto => ({
  campo: 'file',
  contenido: PNG_REAL,
  nombre: 'foto.png',
  tipo: 'image/png',
  ...extra,
});
const id = (c: C) => c.p.carga ?? c.inexistente;
const ruta = (c: C) => `/v2/truck-loads/${id(c)}/photo`;
const fotoDe = async (c: C) =>
  (
    await c.app
      .get(DataSource)
      .getRepository(TruckLoad)
      .findOneByOrFail({ loadId: c.p.carga })
  ).photoKey;

const subir = endpoint<C>('put', '/v2/truck-loads/{id}/photo', ruta);
const ver = endpoint<C>('get', '/v2/truck-loads/{id}/photo', ruta);
const quitar = endpoint<C>('delete', '/v2/truck-loads/{id}/photo', ruta);
const inexistente = (c: C) => `/v2/truck-loads/${c.inexistente}/photo`;

const casos: Array<Caso<C>> = [
  subir('sube la foto', ADMIN, 200, {
    antes: carga(),
    adjunto: adjunto(),
    verificar: async (b, c) => {
      expect(b).toMatchObject({ url: expect.any(String) as string });
      expect(await fotoDe(c)).toEqual(expect.any(String));
    },
  }),
  subir('reemplaza la foto', ADMIN, 200, {
    antes: async (c) => {
      await conFoto()(c);
      c.p.fotoAnterior = (await fotoDe(c)) as string;
    },
    verificar: async (_b, c) => {
      const actual = await fotoDe(c);
      expect(actual).toEqual(expect.any(String));
      expect(actual).not.toBe(c.p.fotoAnterior);
    },
    adjunto: adjunto(),
  }),
  subir('sin archivo', ADMIN, 400, {
    antes: carga(),
    mensaje: /Falta la foto/,
    verificar: async (_b, c) => expect(await fotoDe(c)).toBeNull(),
  }),
  subir('archivo vacío', ADMIN, 400, {
    antes: carga(),
    adjunto: adjunto({ contenido: Buffer.alloc(0) }),
    verificar: async (_b, c) => expect(await fotoDe(c)).toBeNull(),
  }),
  subir('tipo no permitido', ADMIN, 415, {
    antes: carga(),
    adjunto: adjunto({ tipo: 'application/pdf', nombre: 'a.pdf' }),
  }),
  subir('contenido que no coincide con el tipo', ADMIN, 415, {
    antes: carga(),
    adjunto: adjunto({ contenido: Buffer.from('no soy una imagen') }),
  }),
  subir('supera los 5 MB', ADMIN, 413, {
    antes: carga(),
    adjunto: adjunto({ contenido: Buffer.alloc(5 * 1024 * 1024 + 1, 1) }),
  }),
  subir('inexistente', ADMIN, 404, {
    ruta: inexistente,
    adjunto: adjunto(),
  }),
  subir('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambios('truck_load', 'load_id', (c) => c.p.carga, carga('B')),
    adjunto: adjunto(),
  }),
  subir('super admin sin distribuidora', 'super', 400, {
    antes: carga(),
    adjunto: adjunto(),
  }),
  subir('rol no permitido: chofer', 'chofer', 403, {
    antes: carga(),
    adjunto: adjunto(),
  }),
  subir('rol no permitido: cliente', 'clienteA', 403, {
    antes: carga(),
    adjunto: adjunto(),
  }),
  subir('sin token', undefined, 401, { adjunto: adjunto() }),
  subir('id mal formado', ADMIN, 400, {
    ruta: '/v2/truck-loads/no/photo',
    adjunto: adjunto(),
  }),

  ver('sin foto, modo url: null', ADMIN, 200, {
    antes: carga(),
    ruta: (c) => `${ruta(c)}?modo=url`,
    verificar: (b) => expect(b).toMatchObject({ url: null }),
  }),
  ver('con foto, modo url', ADMIN, 200, {
    antes: conFoto(),
    ruta: (c) => `${ruta(c)}?modo=url`,
    verificar: (b) =>
      expect(b).toMatchObject({ url: expect.any(String) as string }),
  }),
  ver('con foto: redirige', ADMIN, 302, { antes: conFoto() }),
  ver('sin foto y sin modo', ADMIN, 404, { antes: carga() }),
  ver('el chofer de la carga', undefined, 200, {
    verificar: (b) =>
      expect(b).toMatchObject({ url: expect.any(String) as string }),
    antes: conFoto(),
    ruta: (c) => `${ruta(c)}?modo=url`,
    cabeceras: comoChofer,
  }),
  ver('otro chofer de la misma distribuidora', 'choferA2', 404, {
    antes: conFoto(),
    ruta: (c) => `${ruta(c)}?modo=url`,
  }),
  ver('modo inválido', ADMIN, 400, {
    antes: conFoto(),
    ruta: (c) => `${ruta(c)}?modo=otro`,
  }),
  ver('inexistente', ADMIN, 404, {
    ruta: (c) => `${inexistente(c)}?modo=url`,
  }),
  ver('de otra distribuidora', ADMIN, 404, {
    antes: conFoto('B'),
    ruta: (c) => `${ruta(c)}?modo=url`,
  }),
  ver('super admin sin distribuidora', 'super', 400, { antes: carga() }),
  ...bordes(ver, {
    prohibidos: ADMIN_O_CHOFER,
    idMalo: '/v2/truck-loads/no/photo',
  }),

  quitar('saca la foto', ADMIN, 200, {
    antes: conFoto(),
    verificar: async (b, c) => {
      expect(b).toMatchObject({ url: null, expiresAt: null });
      expect(await fotoDe(c)).toBeNull();
    },
  }),
  quitar('sin foto', ADMIN, 200, {
    verificar: (b) => expect(b).toMatchObject({ url: null, expiresAt: null }),
    antes: carga(),
  }),
  quitar('inexistente', ADMIN, 404, { ruta: inexistente }),
  quitar('de otra distribuidora no cambia nada', ADMIN, 404, {
    ...sinCambios('truck_load', 'load_id', (c) => c.p.carga, conFoto('B')),
  }),
  quitar('super admin sin distribuidora', 'super', 400, { antes: carga() }),
  ...bordes(quitar, {
    prohibidos: SOLO_ADMIN,
    idMalo: '/v2/truck-loads/no/photo',
  }),
];

/** Matriz T5: foto de la carga, contra un MinIO efímero. */
describe('Matriz HTTP T5: foto de la carga (e2e)', () => {
  let env: TestEnv;
  let minio: TestMinio;
  let ctx: C;
  beforeAll(async () => {
    minio = await startMinio();
    env = await createTestApp({ s3: minio.env });
    ctx = await sembrarBaseT5(env);
  }, 240000);
  afterAll(async () => {
    await env.cleanup();
    await minio.stop();
  });

  correrMatriz('foto', () => ctx, casos);

  it('GET /v2/truck-loads/{id}/photo · 302 a la URL firmada de esa foto', async () => {
    await conFoto()(ctx);
    const key = await fotoDe(ctx);
    const res = await request(ctx.app.getHttpServer())
      .get(ruta(ctx))
      .set(ctx.actores[ADMIN]);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(key as string);
  });
});
