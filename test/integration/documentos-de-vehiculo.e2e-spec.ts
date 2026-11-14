/**
 * F13: documentos del vehículo y foto de la patente, escaneados al subirlos.
 * Matriz HTTP contra Postgres, Redis y un MinIO efímeros. El lector es un doble
 * (no se gasta crédito): cada caso sube un archivo distinto para que M6 no lo
 * tome como duplicado de otro caso.
 */
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Car } from '../../src/car/entities/car.entity';
import {
  DocumentReaderPort,
  LecturaDeDocumento,
} from '../../src/document-reader/document-reader.port';
import { TipoDeDocumento } from '../../src/document-reader/tipos-de-documento';
import { TOPE_DEL_ESCANEO } from '../../src/fleet/car-documents.service';
import { startMinio, TestMinio } from './setup/minio';
import { createTestApp, TestEnv } from './setup/test-env';
import {
  Adjunto,
  Caso,
  Escenario,
  correrMatriz,
  endpoint,
  reiniciarCuposDelThrottler,
  sembrarEscenario,
  sembrarPersona,
  verificarCastellano,
} from './matriz-http/matriz';

jest.setTimeout(180_000);

const PATENTE_A = 'AB123CD';
const MB = 1024 * 1024;

interface DobleDelLector {
  disponible: boolean;
  leer: jest.Mock;
}

interface Ctx extends Escenario {
  env: TestEnv;
  autoA: string;
  /** Otro vehículo de A (para «el adjunto no es de ese vehículo»). */
  autoA2: string;
  autoB: string;
  lector: DobleDelLector;
  /** El archivo que sube el caso (lo arma `antes`). */
  archivo: Buffer;
  /** Avisos de patente del auto A antes del caso (lo arma `prep`). */
  avisosAntes: number;
  /** Un documento de A2 y uno de B, fijos (los suben en `beforeAll`). */
  docA2: string;
  docB: string;
  /** El adjunto de A que usa el caso de descarga o baja (lo arma `antes`). */
  adjunto: string;
}

const lectura = (
  tipo: TipoDeDocumento,
  campos: Record<string, string>,
): LecturaDeDocumento => ({
  tipo,
  legible: true,
  campos: Object.entries(campos).map(([nombre, valor]) => ({
    nombre,
    valor,
    confianza: 'alta',
  })),
  avisos: [],
  uso: {
    modelo: 'doble',
    tokensDeEntrada: 10,
    tokensDeSalida: 5,
    costoUsd: 0.0001,
  },
});

const POLIZA = lectura(TipoDeDocumento.POLIZA, {
  aseguradora: 'Seguros Norte',
  numero_de_poliza: 'P-123',
  vigencia_desde: '2026-01-01',
  vigencia_hasta: '2027-01-01',
  patente: PATENTE_A,
});
const patenteLeida = (valor: string) =>
  lectura(TipoDeDocumento.FOTO_DE_PATENTE, { patente: valor });

const pdfUnico = () =>
  Buffer.from(`%PDF-1.4\n% ${randomUUID()}\n1 0 obj << >> endobj\n%%EOF\n`);
const pngUnico = () =>
  sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: {
        r: Math.floor(Math.random() * 256),
        g: Math.floor(Math.random() * 256),
        b: Math.floor(Math.random() * 256),
      },
    },
  })
    .png()
    .toBuffer();

/** Cada caso arranca con el lector disponible y un archivo nuevo. */
const prep =
  (o: { pdf?: boolean; disponible?: boolean; lee?: unknown } = {}) =>
  async (c: Ctx) => {
    c.lector.disponible = o.disponible ?? true;
    c.lector.leer.mockReset();
    c.lector.leer.mockResolvedValue(o.lee ?? POLIZA);
    c.archivo = o.pdf === false ? await pngUnico() : pdfUnico();
    c.avisosAntes = (await avisosDelAuto(c, c.autoA)).length;
  };

/** Sube un documento (sin lector, no gasta) y devuelve su id. */
const subirUno = async (c: Ctx, carId: string, actor = 'adminA') => {
  c.lector.disponible = false;
  const res = await request(c.app.getHttpServer())
    .post(`/v2/cars/${carId}/documents`)
    .set(c.actores[actor])
    .field('documentType', 'seguro')
    .attach('file', pdfUnico(), {
      filename: 'poliza.pdf',
      contentType: 'application/pdf',
    });
  expect(res.status).toBe(201);
  return (res.body as Respuesta).attachment.attachmentId;
};
/** `antes` de los casos de descarga y baja: un adjunto nuevo de A. */
const conAdjunto = async (c: Ctx) => {
  c.adjunto = await subirUno(c, c.autoA);
};

const doc = (
  documentType: string | undefined,
  extra: Partial<Adjunto> = {},
): ((c: Ctx) => Adjunto) => {
  return (c) => ({
    campo: 'file',
    contenido: c.archivo,
    nombre: 'documento.pdf',
    tipo: 'application/pdf',
    campos: documentType ? { documentType } : {},
    ...extra,
  });
};
const foto =
  (extra: Partial<Adjunto> = {}) =>
  (c: Ctx): Adjunto => ({
    campo: 'file',
    contenido: c.archivo,
    nombre: 'patente.png',
    tipo: 'image/png',
    ...extra,
  });

const rutaDoc = (c: Ctx) => `/v2/cars/${c.autoA}/documents`;
const rutaFoto = (c: Ctx) => `/v2/cars/${c.autoA}/documents/patent-photo`;
const subirDoc = endpoint<Ctx>('post', '/v2/cars/{carId}/documents', rutaDoc);
const subirFoto = endpoint<Ctx>(
  'post',
  '/v2/cars/{carId}/documents/patent-photo',
  rutaFoto,
);

const listar = endpoint<Ctx>(
  'get',
  '/v2/cars/{carId}/documents',
  (c) => `/v2/cars/${c.autoA}/documents`,
);
const bajar = endpoint<Ctx>(
  'get',
  '/v2/cars/{carId}/documents/{attachmentId}/download',
  (c) => `/v2/cars/${c.autoA}/documents/${c.adjunto}/download?modo=url`,
);
const borrar = endpoint<Ctx>(
  'delete',
  '/v2/cars/{carId}/documents/{attachmentId}',
  (c) => `/v2/cars/${c.autoA}/documents/${c.adjunto}`,
);

const ds = (c: Ctx) => c.app.get(DataSource);
const adjuntosDe = async (c: Ctx, carId: string) =>
  Number(
    (
      await ds(c).query<Array<{ n: string }>>(
        `SELECT count(*) AS n FROM attachment WHERE owner_type = 'car_document' AND owner_id = $1`,
        [carId],
      )
    )[0].n,
  );
const lecturaDe = async (c: Ctx, attachmentId: string) =>
  (
    await ds(c).query<
      Array<{
        status: string;
        expected_type: string | null;
        distributor_id: string;
      }>
    >(
      `SELECT status, expected_type, distributor_id FROM document_reading WHERE attachment_id = $1`,
      [attachmentId],
    )
  )[0];
/** Los avisos de patente de un vehículo, en orden de alta. */
const avisosDelAuto = (c: Ctx, carId: string) =>
  ds(c).query<Array<Record<string, string>>>(
    `SELECT distributor_id, kind, title, body, link_entity, link_id, dedupe_key
       FROM admin_notification
      WHERE kind = 'car_patent_mismatch' AND link_id = $1
      ORDER BY created_at`,
    [carId],
  );
/**
 * Espera a que el vehículo tenga `cuantos` avisos (el aviso lo guarda un
 * listener asíncrono): hasta 5 s si tiene que aparecer uno; si no, mira 1 s
 * que no aparezca otro.
 */
const avisosHasta = async (
  c: Ctx,
  carId: string,
  cuantos: number,
  esperarUnoNuevo: boolean,
): Promise<Array<Record<string, string>>> => {
  let filas: Array<Record<string, string>> = [];
  for (let i = 0; i < (esperarUnoNuevo ? 50 : 10); i++) {
    filas = await avisosDelAuto(c, carId);
    if (esperarUnoNuevo && filas.length >= cuantos) return filas;
    await new Promise((r) => setTimeout(r, 100));
  }
  return filas;
};

interface Respuesta {
  attachment: { attachmentId: string; ownerType: string; ownerId: string };
  scan: {
    available: boolean;
    data: Record<string, unknown> | null;
    warning?: string;
  };
  mismatch?: boolean;
  expectedPatent?: string | null;
  readPatent?: string | null;
  warning?: string | null;
}

/** El adjunto quedó en el auto, protegido, y se baja sólo con URL firmada. */
const verificarAdjunto = async (b: Respuesta, c: Ctx, actor = 'adminA') => {
  expect(b.attachment).toMatchObject({
    ownerType: 'car_document',
    ownerId: c.autoA,
  });
  const res = await request(c.app.getHttpServer())
    .get(
      `/v2/cars/${c.autoA}/documents/${b.attachment.attachmentId}/download?modo=url`,
    )
    .set(c.actores[actor]);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    url: expect.stringContaining('X-Amz-Signature') as string,
  });
};

/** El listado trae el adjunto nuevo primero y sólo los de ese vehículo. */
function verificarListado(cuerpo: unknown, c: Ctx): void {
  const lista = cuerpo as Array<Record<string, unknown>>;
  expect(lista[0]).toMatchObject({
    attachmentId: c.adjunto,
    ownerType: 'car_document',
    ownerId: c.autoA,
    label: 'Documento de seguro del vehículo',
  });
  expect(lista.filter((a) => a.ownerId !== c.autoA)).toEqual([]);
  expect(lista.map((a) => a.attachmentId)).not.toContain(c.docA2);
}

/** Tras la baja: no se lista, no se baja y la fila quedó marcada (lógica). */
async function verificarBaja(_cuerpo: unknown, c: Ctx): Promise<void> {
  const lista = await request(c.app.getHttpServer())
    .get(`/v2/cars/${c.autoA}/documents`)
    .set(c.actores.adminA);
  const ids = (lista.body as Array<{ attachmentId: string }>).map(
    (a) => a.attachmentId,
  );
  const descarga = await request(c.app.getHttpServer())
    .get(`/v2/cars/${c.autoA}/documents/${c.adjunto}/download?modo=url`)
    .set(c.actores.adminA);
  const [fila] = await ds(c).query<Array<{ borrado: boolean }>>(
    `SELECT deleted_at IS NOT NULL AS borrado FROM attachment WHERE attachment_id = $1`,
    [c.adjunto],
  );
  expect({
    listado: ids.includes(c.adjunto),
    descarga: descarga.status,
    fila,
  }).toEqual({ listado: false, descarga: 404, fila: { borrado: true } });
}

const casos: Array<Caso<Ctx>> = [
  // --- Documento del vehículo ---
  subirDoc('seguro: guarda, escanea y precarga', 'adminA', 201, {
    antes: prep(),
    adjunto: doc('seguro'),
    verificar: async (cuerpo, c) => {
      const b = cuerpo as Respuesta;
      await verificarAdjunto(b, c);
      expect(b.scan).toEqual({
        available: true,
        data: {
          detectedType: 'poliza',
          expirationDate: '2027-01-01',
          issueDate: '2026-01-01',
          insurer: 'Seguros Norte',
          policyNumber: 'P-123',
          patent: PATENTE_A,
          warnings: [],
        },
      });
      expect(c.lector.leer).toHaveBeenCalledTimes(1);
      expect(c.lector.leer).toHaveBeenCalledWith(
        expect.objectContaining({ mimeType: 'application/pdf' }),
        expect.objectContaining({ tipoEsperado: 'poliza' }),
      );
      expect(await lecturaDe(c, b.attachment.attachmentId)).toEqual({
        status: 'read',
        expected_type: 'poliza',
        distributor_id: c.distA.id,
      });
    },
  }),
  subirDoc('vtv en imagen', 'adminA', 201, {
    antes: prep({
      pdf: false,
      lee: lectura(TipoDeDocumento.REVISION_TECNICA, {
        fecha_de_revision: '2026-03-01',
        vencimiento: '2027-03-01',
      }),
    }),
    adjunto: doc('vtv', { nombre: 'vtv.png', tipo: 'image/png' }),
    verificar: (cuerpo) =>
      expect((cuerpo as Respuesta).scan.data).toMatchObject({
        detectedType: 'revision_tecnica',
        expirationDate: '2027-03-01',
        issueDate: '2026-03-01',
      }),
  }),
  subirDoc('super admin en modo soporte sobre A', 'soporteA', 403, {
    antes: prep(),
    adjunto: doc('cedula'),
    code: 'SUPPORT_READ_ONLY',
  }),
  subirDoc('lector no disponible: la subida vale igual', 'adminA', 201, {
    antes: prep({ disponible: false }),
    adjunto: doc('otro'),
    verificar: async (cuerpo, c) => {
      const b = cuerpo as Respuesta;
      expect(b.scan).toEqual({ available: false, data: null });
      expect(c.lector.leer).not.toHaveBeenCalled();
      await verificarAdjunto(b, c);
    },
  }),
  subirDoc('el lector falla: la subida vale igual', 'adminA', 201, {
    antes: async (c) => {
      await prep()(c);
      c.lector.leer.mockRejectedValue(new Error('el modelo no respondió'));
    },
    adjunto: doc('seguro'),
    verificar: async (cuerpo, c) => {
      const b = cuerpo as Respuesta;
      expect(b.scan).toMatchObject({ available: true, data: null });
      expect(b.scan.warning).toMatch(/cargá los datos a mano/);
      await verificarAdjunto(b, c);
    },
  }),
  subirDoc('sin tipo de documento', 'adminA', 400, {
    antes: prep(),
    adjunto: doc(undefined),
  }),
  subirDoc('tipo de documento inválido', 'adminA', 400, {
    antes: prep(),
    adjunto: doc('pasaporte'),
  }),
  subirDoc('sin archivo', 'adminA', 400, {
    antes: prep(),
    body: { documentType: 'vtv' },
    mensaje: /Falta el archivo/,
  }),
  subirDoc('archivo vacío', 'adminA', 400, {
    antes: async (c) => {
      await prep()(c);
      c.archivo = Buffer.alloc(0);
    },
    adjunto: doc('vtv'),
  }),
  subirDoc('id mal formado', 'adminA', 400, {
    antes: prep(),
    ruta: '/v2/cars/no-es-uuid/documents',
    adjunto: doc('vtv'),
  }),
  subirDoc(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    { antes: prep(), adjunto: doc('vtv'), code: 'SUPPORT_SESSION_REQUIRED' },
  ),
  subirDoc('sin token', undefined, 401, {
    antes: prep(),
    adjunto: doc('vtv'),
  }),
  subirDoc('token de alguien que no existe', 'tokenInvalido', 401, {
    antes: prep(),
    adjunto: doc('vtv'),
  }),
  subirDoc('rol no permitido: chofer', 'chofer', 403, {
    antes: prep(),
    adjunto: doc('vtv'),
  }),
  subirDoc('rol no permitido: cliente', 'clienteA', 403, {
    antes: prep(),
    adjunto: doc('vtv'),
  }),
  subirDoc('vehículo inexistente', 'adminA', 404, {
    antes: prep(),
    ruta: (c) => `/v2/cars/${c.inexistente}/documents`,
    adjunto: doc('vtv'),
  }),
  subirDoc('vehículo de otra distribuidora: no guarda ni lee', 'adminA', 404, {
    antes: prep(),
    ruta: (c) => `/v2/cars/${c.autoB}/documents`,
    adjunto: doc('vtv'),
    verificar: async (_b, c) => {
      // Sólo el documento fijo de B (`docB`, del beforeAll).
      expect(await adjuntosDe(c, c.autoB)).toBe(1);
      expect(c.lector.leer).not.toHaveBeenCalled();
    },
  }),
  subirDoc('supera los 10 MB', 'adminA', 413, {
    antes: async (c) => {
      await prep()(c);
      c.archivo = Buffer.concat([pdfUnico(), Buffer.alloc(10 * MB, 1)]);
    },
    adjunto: doc('vtv'),
  }),
  subirDoc('tipo no permitido (CSV)', 'adminA', 415, {
    antes: async (c) => {
      await prep()(c);
      c.archivo = Buffer.from('patente;vence\nAB123CD;2027-01-01\n');
    },
    adjunto: doc('vtv', { nombre: 'datos.csv', tipo: 'text/csv' }),
    verificar: (_b, c) => expect(c.lector.leer).not.toHaveBeenCalled(),
  }),
  subirDoc('contenido que no coincide con el tipo', 'adminA', 415, {
    antes: async (c) => {
      await prep()(c);
      c.archivo = Buffer.from('no soy un pdf');
    },
    adjunto: doc('vtv'),
  }),

  // --- Foto de la patente ---
  subirFoto('coincide (normalizada): sin advertencia ni aviso', 'adminA', 201, {
    antes: prep({ pdf: false, lee: patenteLeida('ab 123-cd') }),
    adjunto: foto(),
    verificar: async (cuerpo, c) => {
      const b = cuerpo as Respuesta;
      await verificarAdjunto(b, c);
      expect(b).toMatchObject({
        mismatch: false,
        expectedPatent: PATENTE_A,
        readPatent: PATENTE_A,
        warning: null,
      });
      expect(c.lector.leer).toHaveBeenCalledWith(
        expect.objectContaining({ mimeType: 'image/png' }),
        expect.objectContaining({ tipoEsperado: 'foto_de_patente' }),
      );
      expect(await lecturaDe(c, b.attachment.attachmentId)).toMatchObject({
        status: 'read',
        expected_type: 'foto_de_patente',
      });
      expect(await avisosHasta(c, c.autoA, 0, false)).toHaveLength(
        c.avisosAntes,
      );
    },
  }),
  subirFoto('no coincide: advertencia y aviso en la bandeja', 'adminA', 201, {
    antes: prep({ pdf: false, lee: patenteLeida('AC456EF') }),
    adjunto: foto(),
    verificar: async (cuerpo, c) => {
      const b = cuerpo as Respuesta;
      expect(b).toMatchObject({
        mismatch: true,
        expectedPatent: PATENTE_A,
        readPatent: 'AC456EF',
      });
      expect(b.warning).toMatch(/no coincide/);
      const avisos = await avisosHasta(c, c.autoA, c.avisosAntes + 1, true);
      expect(avisos.at(-1)).toEqual(
        expect.objectContaining({
          distributor_id: c.distA.id,
          kind: 'car_patent_mismatch',
          link_entity: 'car',
          link_id: c.autoA,
          dedupe_key: `car-patent-mismatch:${c.autoA}:${PATENTE_A}:AC456EF`,
        }),
      );
      expect(avisos.at(-1)?.body).toContain('AC456EF');
    },
  }),
  subirFoto('lector no disponible: guarda la foto sin aviso', 'adminA', 201, {
    antes: prep({ pdf: false, disponible: false }),
    adjunto: foto(),
    verificar: async (cuerpo, c) => {
      const b = cuerpo as Respuesta;
      expect(b).toMatchObject({
        scan: { available: false, data: null },
        mismatch: false,
        readPatent: null,
        warning: null,
      });
      expect(c.lector.leer).not.toHaveBeenCalled();
      await verificarAdjunto(b, c);
      expect(await avisosHasta(c, c.autoA, 0, false)).toHaveLength(
        c.avisosAntes,
      );
    },
  }),
  subirFoto('sin archivo', 'adminA', 400, {
    antes: prep({ pdf: false }),
    mensaje: /Falta el archivo/,
  }),
  subirFoto('id mal formado', 'adminA', 400, {
    antes: prep({ pdf: false }),
    ruta: '/v2/cars/no-es-uuid/documents/patent-photo',
    adjunto: foto(),
  }),
  subirFoto(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    {
      antes: prep({ pdf: false }),
      adjunto: foto(),
      code: 'SUPPORT_SESSION_REQUIRED',
    },
  ),
  subirFoto('sin token', undefined, 401, {
    antes: prep({ pdf: false }),
    adjunto: foto(),
  }),
  subirFoto('token de alguien que no existe', 'tokenInvalido', 401, {
    antes: prep({ pdf: false }),
    adjunto: foto(),
  }),
  subirFoto('rol no permitido: chofer', 'chofer', 403, {
    antes: prep({ pdf: false }),
    adjunto: foto(),
  }),
  subirFoto('vehículo inexistente', 'adminA', 404, {
    antes: prep({ pdf: false }),
    ruta: (c) => `/v2/cars/${c.inexistente}/documents/patent-photo`,
    adjunto: foto(),
  }),
  subirFoto('vehículo de otra distribuidora: no guarda ni lee', 'adminA', 404, {
    antes: prep({ pdf: false }),
    ruta: (c) => `/v2/cars/${c.autoB}/documents/patent-photo`,
    adjunto: foto(),
    verificar: async (_b, c) => {
      // Sólo el documento fijo de B (`docB`, del beforeAll).
      expect(await adjuntosDe(c, c.autoB)).toBe(1);
      expect(c.lector.leer).not.toHaveBeenCalled();
    },
  }),
  subirFoto('supera los 10 MB', 'adminA', 413, {
    antes: async (c) => {
      await prep({ pdf: false })(c);
      c.archivo = Buffer.concat([c.archivo, Buffer.alloc(10 * MB, 1)]);
    },
    adjunto: foto(),
  }),
  subirFoto('un PDF no es una foto', 'adminA', 415, {
    antes: prep(),
    adjunto: foto({ nombre: 'patente.pdf', tipo: 'application/pdf' }),
    verificar: (_b, c) => expect(c.lector.leer).not.toHaveBeenCalled(),
  }),

  // --- Listar (v2, flota.ver) ---
  listar('lista los documentos y fotos del vehículo', 'adminA', 200, {
    antes: conAdjunto,
    verificar: verificarListado,
  }),
  listar('super admin en modo soporte sobre A', 'soporteA', 200),
  listar('rol con flota.ver (sin catálogo)', 'rolFlota', 200),
  listar('id mal formado', 'adminA', 400, {
    ruta: '/v2/cars/no-es-uuid/documents',
  }),
  listar(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    { code: 'SUPPORT_SESSION_REQUIRED' },
  ),
  listar('sin token', undefined, 401),
  listar('rol no permitido: chofer', 'chofer', 403),
  listar('rol no permitido: cliente', 'clienteA', 403),
  listar('rol del personal sin flota.ver (sólo catálogo)', 'rolCatalogo', 403),
  listar('vehículo inexistente', 'adminA', 404, {
    ruta: (c) => `/v2/cars/${c.inexistente}/documents`,
  }),
  listar('vehículo de otra distribuidora', 'adminA', 404, {
    ruta: (c) => `/v2/cars/${c.autoB}/documents`,
    mensaje: 'Vehículo no encontrado',
  }),

  // --- Bajar (v2, flota.ver) ---
  bajar('URL firmada', 'adminA', 200, {
    antes: conAdjunto,
    verificar: (cuerpo) =>
      expect(cuerpo).toMatchObject({
        url: expect.stringContaining('X-Amz-Signature') as string,
      }),
  }),
  bajar('rol con flota.ver (sin catálogo)', 'rolFlota', 200, {
    antes: conAdjunto,
  }),
  bajar('sin modo: redirige a la URL firmada', 'adminA', 302, {
    antes: conAdjunto,
    ruta: (c) => `/v2/cars/${c.autoA}/documents/${c.adjunto}/download`,
  }),
  bajar('id del adjunto mal formado', 'adminA', 400, {
    ruta: (c) => `/v2/cars/${c.autoA}/documents/no-es-uuid/download?modo=url`,
  }),
  bajar('modo inválido', 'adminA', 400, {
    antes: conAdjunto,
    ruta: (c) => `/v2/cars/${c.autoA}/documents/${c.adjunto}/download?modo=pdf`,
  }),
  bajar('sin token', undefined, 401, { antes: conAdjunto }),
  bajar('rol no permitido: chofer', 'chofer', 403, { antes: conAdjunto }),
  bajar('rol del personal sin flota.ver (sólo catálogo)', 'rolCatalogo', 403, {
    antes: conAdjunto,
  }),
  bajar('adjunto inexistente', 'adminA', 404, {
    ruta: (c) =>
      `/v2/cars/${c.autoA}/documents/${c.inexistente}/download?modo=url`,
    mensaje: 'Adjunto no encontrado',
  }),
  bajar('el adjunto es de otro vehículo de la distribuidora', 'adminA', 404, {
    ruta: (c) => `/v2/cars/${c.autoA}/documents/${c.docA2}/download?modo=url`,
    mensaje: 'Adjunto no encontrado',
  }),
  bajar('vehículo de otra distribuidora', 'adminA', 404, {
    ruta: (c) => `/v2/cars/${c.autoB}/documents/${c.docB}/download?modo=url`,
    mensaje: 'Vehículo no encontrado',
  }),
  bajar('adjunto de otra distribuidora por un vehículo propio', 'adminB', 404, {
    antes: conAdjunto,
    ruta: (c) => `/v2/cars/${c.autoB}/documents/${c.adjunto}/download?modo=url`,
    mensaje: 'Adjunto no encontrado',
  }),

  // --- Dar de baja (v2, flota.gestionar) ---
  borrar('baja lógica: deja de listarse y de bajarse', 'adminA', 204, {
    antes: conAdjunto,
    verificar: verificarBaja,
  }),
  borrar('super admin en modo soporte sobre A', 'soporteA', 403, {
    antes: conAdjunto,
    code: 'SUPPORT_READ_ONLY',
  }),
  borrar('ya dado de baja', 'adminA', 404, {
    antes: async (c) => {
      await conAdjunto(c);
      const res = await request(c.app.getHttpServer())
        .delete(`/v2/cars/${c.autoA}/documents/${c.adjunto}`)
        .set(c.actores.adminA);
      expect(res.status).toBe(204);
    },
    mensaje: 'Adjunto no encontrado',
  }),
  borrar('id del adjunto mal formado', 'adminA', 400, {
    ruta: (c) => `/v2/cars/${c.autoA}/documents/no-es-uuid`,
  }),
  borrar('id del vehículo mal formado', 'adminA', 400, {
    antes: conAdjunto,
    ruta: (c) => `/v2/cars/no-es-uuid/documents/${c.adjunto}`,
  }),
  borrar(
    'super admin sin distribuidora (sin sesión de soporte)',
    'super',
    403,
    { antes: conAdjunto, code: 'SUPPORT_SESSION_REQUIRED' },
  ),
  borrar('sin token', undefined, 401, { antes: conAdjunto }),
  borrar('rol no permitido: chofer', 'chofer', 403, { antes: conAdjunto }),
  borrar('rol del personal sin flota.gestionar', 'rolFlota', 403, {
    antes: conAdjunto,
    verificar: async (_b, c) => {
      const [fila] = await ds(c).query<Array<{ borrado: boolean }>>(
        `SELECT deleted_at IS NOT NULL AS borrado FROM attachment WHERE attachment_id = $1`,
        [c.adjunto],
      );
      expect(fila).toEqual({ borrado: false });
    },
  }),
  borrar('adjunto inexistente', 'adminA', 404, {
    ruta: (c) => `/v2/cars/${c.autoA}/documents/${c.inexistente}`,
  }),
  borrar('el adjunto es de otro vehículo de la distribuidora', 'adminA', 404, {
    ruta: (c) => `/v2/cars/${c.autoA}/documents/${c.docA2}`,
    mensaje: 'Adjunto no encontrado',
    verificar: async (_b, c) => {
      const [fila] = await ds(c).query<Array<{ borrado: boolean }>>(
        `SELECT deleted_at IS NOT NULL AS borrado FROM attachment WHERE attachment_id = $1`,
        [c.docA2],
      );
      expect(fila).toEqual({ borrado: false });
    },
  }),
  borrar('vehículo de otra distribuidora', 'adminA', 404, {
    ruta: (c) => `/v2/cars/${c.autoB}/documents/${c.docB}`,
    mensaje: 'Vehículo no encontrado',
  }),
  borrar(
    'adjunto de otra distribuidora por un vehículo propio',
    'adminB',
    404,
    {
      antes: conAdjunto,
      ruta: (c) => `/v2/cars/${c.autoB}/documents/${c.adjunto}`,
      mensaje: 'Adjunto no encontrado',
    },
  ),
];

describe('Documentos del vehículo y foto de la patente (F13, e2e)', () => {
  let minio: TestMinio;
  let env: TestEnv;
  let ctx: Ctx;
  const lector: DobleDelLector = { disponible: true, leer: jest.fn() };

  beforeAll(async () => {
    minio = await startMinio();
    env = await createTestApp({
      s3: minio.env,
      overrides: [
        { token: DocumentReaderPort, value: lector },
        { token: TOPE_DEL_ESCANEO, value: 300 },
      ],
    });
    const base = await sembrarEscenario(env.app);
    const choferB = await sembrarPersona(
      env.app,
      'delivery',
      'chofer-b',
      base.distB.id,
    );
    const auto = async (
      distributorId: string,
      userId: string,
      carPatent: string,
    ) =>
      (
        await env.app
          .get(DataSource)
          .getRepository(Car)
          .save({
            distributorId,
            userId,
            carPatent,
            typeCar: 'Camioneta',
          } as Partial<Car>)
      ).carId;
    ctx = {
      ...base,
      env,
      lector,
      archivo: Buffer.alloc(0),
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
      autoA: await auto(base.distA.id, base.choferA.userId, PATENTE_A),
      autoA2: await auto(base.distA.id, base.choferA.userId, 'AC000AA'),
      autoB: await auto(base.distB.id, choferB.userId, 'AA111BB'),
      avisosAntes: 0,
      docA2: '',
      docB: '',
      adjunto: '',
    };
    // Admins de A con un rol del personal acotado (F37): sólo catálogo, y
    // flota.ver sin flota.gestionar.
    const conRol = async (etiqueta: string, permisos: string[]) => {
      const persona = await sembrarPersona(
        env.app,
        'admin',
        etiqueta,
        base.distA.id,
      );
      const ds = env.app.get(DataSource);
      const [{ staff_role_id }] = await ds.query<
        Array<{ staff_role_id: string }>
      >(
        `INSERT INTO staff_role (distributor_id, name, permissions)
         VALUES ($1, $2, $3) RETURNING staff_role_id`,
        [base.distA.id, `Rol ${etiqueta}`, permisos],
      );
      await ds.query(`UPDATE admin SET staff_role_id = $2 WHERE user_id = $1`, [
        persona.userId,
        staff_role_id,
      ]);
      return persona.cabeceras;
    };
    ctx.actores.rolCatalogo = await conRol('rol-catalogo', [
      'catalogo.ver',
      'catalogo.gestionar',
    ]);
    ctx.actores.rolFlota = await conRol('rol-flota', ['flota.ver']);
    ctx.docA2 = await subirUno(ctx, ctx.autoA2);
    ctx.docB = await subirUno(ctx, ctx.autoB, 'adminB');
  }, 240_000);

  afterAll(async () => {
    await env?.cleanup();
    await minio?.stop();
  });

  correrMatriz('F13', () => ctx, casos);

  it('la foto de la patente queda aparte de los documentos, con su etiqueta', async () => {
    await prep({ pdf: false, lee: patenteLeida(PATENTE_A) })(ctx);
    const res = await request(ctx.app.getHttpServer())
      .post(rutaFoto(ctx))
      .set(ctx.actores.adminA)
      .attach('file', ctx.archivo, {
        filename: 'patente.png',
        contentType: 'image/png',
      });
    expect(res.status).toBe(201);
    const [fila] = await ds(ctx).query<
      Array<{ label: string; mime_type: string; storage_key: string }>
    >(
      `SELECT label, mime_type, storage_key FROM attachment WHERE attachment_id = $1`,
      [(res.body as Respuesta).attachment.attachmentId],
    );
    expect(fila).toMatchObject({
      label: 'Foto de patente',
      mime_type: 'image/png',
    });
    expect(fila.storage_key).toContain(
      `attachments/${ctx.distA.id}/car_document/${ctx.autoA}/`,
    );
  });

  it('otra distribuidora no baja el documento de A', async () => {
    await prep()(ctx);
    const res = await request(ctx.app.getHttpServer())
      .post(rutaDoc(ctx))
      .set(ctx.actores.adminA)
      .field('documentType', 'seguro')
      .attach('file', ctx.archivo, {
        filename: 'poliza.pdf',
        contentType: 'application/pdf',
      });
    expect(res.status).toBe(201);
    const id = (res.body as Respuesta).attachment.attachmentId;
    for (const ruta of [
      `/v2/cars/${ctx.autoA}/documents/${id}/download?modo=url`,
      `/v2/cars/${ctx.autoB}/documents/${id}/download?modo=url`,
      `/attachments/${id}/download?modo=url`,
    ]) {
      const ajeno = await request(ctx.app.getHttpServer())
        .get(ruta)
        .set(ctx.actores.adminB);
      expect({ ruta, estado: ajeno.status }).toEqual({ ruta, estado: 404 });
    }
  });

  it('los GET genéricos de adjuntos no muestran documentos del vehículo (ni con catalogo.ver)', async () => {
    const id = await subirUno(ctx, ctx.autoA);
    for (const actor of ['adminA', 'rolCatalogo']) {
      for (const ruta of [
        `/attachments/car_document/${ctx.autoA}`,
        `/attachments/${id}/download?modo=url`,
        `/attachments/${id}/download`,
      ]) {
        const res = await request(ctx.app.getHttpServer())
          .get(ruta)
          .set(ctx.actores[actor]);
        expect({ actor, ruta, estado: res.status }).toEqual({
          actor,
          ruta,
          estado: 400,
        });
        verificarCastellano(res.body, res.status);
        expect(String((res.body as { message: string }).message)).toContain(
          'GET /api/v2/cars/:id/documents',
        );
      }
    }
    // Y la ruta v2 le pide flota.ver a ese rol.
    const v2 = await request(ctx.app.getHttpServer())
      .get(`/v2/cars/${ctx.autoA}/documents/${id}/download?modo=url`)
      .set(ctx.actores.rolCatalogo);
    expect(v2.status).toBe(403);
  });

  it('la v1 de /cars/:carId/documents (estado de la documentación) convive con la v2', async () => {
    const id = await subirUno(ctx, ctx.autoA);
    for (const ruta of [
      `/cars/${ctx.autoA}/documents`,
      `/v1/cars/${ctx.autoA}/documents`,
    ]) {
      const v1 = await request(ctx.app.getHttpServer())
        .get(ruta)
        .set(ctx.actores.adminA);
      expect({ ruta, estado: v1.status }).toEqual({ ruta, estado: 200 });
      expect(v1.body).toMatchObject({
        carId: ctx.autoA,
        isLocked: expect.any(Boolean) as boolean,
        tasks: expect.any(Array) as unknown[],
      });
    }
    const v2 = await request(ctx.app.getHttpServer())
      .get(`/v2/cars/${ctx.autoA}/documents`)
      .set(ctx.actores.adminA);
    expect(v2.status).toBe(200);
    expect(Array.isArray(v2.body)).toBe(true);
    expect(
      (v2.body as Array<{ attachmentId: string }>).map((a) => a.attachmentId),
    ).toContain(id);
    // Las rutas nuevas no existen en v1.
    const v1Baja = await request(ctx.app.getHttpServer())
      .delete(`/v1/cars/${ctx.autoA}/documents/${id}`)
      .set(ctx.actores.adminA);
    expect(v1Baja.status).toBe(404);
  });

  it('el aviso de patente es uno por hecho: misma patente equivocada en 2 fotos → 1; otra patente leída → 2', async () => {
    const carId = (
      await ds(ctx)
        .getRepository(Car)
        .save({
          distributorId: ctx.distA.id,
          userId: ctx.choferA.userId,
          carPatent: 'AF111AA',
          typeCar: 'Camioneta',
        } as Partial<Car>)
    ).carId;
    const foto = async (leida: string) => {
      await prep({ pdf: false, lee: patenteLeida(leida) })(ctx);
      const res = await request(ctx.app.getHttpServer())
        .post(`/v2/cars/${carId}/documents/patent-photo`)
        .set(ctx.actores.adminA)
        .attach('file', ctx.archivo, {
          filename: 'patente.png',
          contentType: 'image/png',
        });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ mismatch: true });
    };

    await foto('AG222BB');
    expect(await avisosHasta(ctx, carId, 1, true)).toHaveLength(1);
    await foto('ag 222-bb');
    expect(await avisosHasta(ctx, carId, 2, false)).toHaveLength(1);
    await foto('AH333CC');
    const avisos = await avisosHasta(ctx, carId, 2, true);
    expect(avisos.map((a) => a.dedupe_key)).toEqual([
      `car-patent-mismatch:${carId}:AF111AA:AG222BB`,
      `car-patent-mismatch:${carId}:AF111AA:AH333CC`,
    ]);
  });

  it('dos subidas del mismo archivo mientras el lector sigue leyendo: el lector se llama una sola vez', async () => {
    // El tope de la suite es 300 ms y el lector tarda 1,5 s: las dos subidas
    // vuelven por el tope con la lectura todavía en curso.
    ctx.lector.disponible = true;
    ctx.lector.leer.mockReset();
    ctx.lector.leer.mockImplementation(
      () =>
        new Promise((resolver) => setTimeout(() => resolver(POLIZA), 1_500)),
    );
    const mismo = pdfUnico();
    const subir = () =>
      request(ctx.app.getHttpServer())
        .post(rutaDoc(ctx))
        .set(ctx.actores.adminA)
        .field('documentType', 'seguro')
        .attach('file', mismo, {
          filename: 'poliza.pdf',
          contentType: 'application/pdf',
        });
    const [r1, r2] = await Promise.all([subir(), subir()]);
    for (const r of [r1, r2]) {
      expect(r.status).toBe(201);
      expect((r.body as Respuesta).scan).toMatchObject({
        available: true,
        data: null,
        warning: expect.stringMatching(/tardó demasiado/) as string,
      });
    }
    const ids = [r1, r2].map(
      (r) => (r.body as Respuesta).attachment.attachmentId,
    );
    // Se espera a que terminen las dos lecturas que quedaron en curso.
    let estados: string[] = [];
    for (let i = 0; i < 100; i++) {
      estados = (
        await ds(ctx).query<Array<{ status: string }>>(
          `SELECT status FROM document_reading WHERE attachment_id = ANY($1)`,
          [ids],
        )
      )
        .map((f) => f.status)
        .sort();
      if (estados.length === 2 && !estados.includes('pending')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(estados).toEqual(['duplicate', 'read']);
    expect(ctx.lector.leer).toHaveBeenCalledTimes(1);
  });

  it('el endpoint genérico de adjuntos no deja saltear el escaneo', async () => {
    await prep()(ctx);
    const res = await request(ctx.app.getHttpServer())
      .post(`/attachments/car_document/${ctx.autoA}`)
      .set(ctx.actores.adminA)
      .attach('file', ctx.archivo, {
        filename: 'poliza.pdf',
        contentType: 'application/pdf',
      });
    expect(res.status).toBe(400);
    const mensaje = String((res.body as { message: string }).message);
    expect(mensaje).toContain('«documento del vehículo»');
    expect(mensaje).toContain('/api/v2/cars/:id/documents');
    verificarCastellano(res.body, res.status);
  });
});
