/**
 * Módulo M6, etapa 2: las lecturas de documentos contra Postgres y Redis reales.
 * El lector es de mentira (y lento, para que las carreras se crucen): no se gasta
 * crédito. Prueba lo que los tests unitarios no pueden: el cerrojo, las FK
 * compuestas de tenant y el gasto por mes de lectura.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

import {
  DocumentReaderPort,
  LecturaDeDocumento,
} from '../../src/document-reader/document-reader.port';
import { TipoDeDocumento } from '../../src/document-reader/tipos-de-documento';
import { DocumentReadingService } from '../../src/document-reading/document-reading.service';
import { DocumentReadingStatus } from '../../src/document-reading/entities/document-reading.entity';
import { createTestApp, telefonoDePrueba, TestEnv } from './setup/test-env';

jest.setTimeout(180_000);

const lecturaDePrueba: LecturaDeDocumento = {
  tipo: TipoDeDocumento.COMPROBANTE_DE_PAGO,
  legible: true,
  campos: [{ nombre: 'importe', valor: '100.00', confianza: 'alta' }],
  avisos: [],
  uso: {
    modelo: 'claude-opus-5-5',
    tokensDeEntrada: 1000,
    tokensDeSalida: 100,
    costoUsd: 0.006,
  },
};

describe('Lecturas de documentos (M6 E2, e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let lecturas: DocumentReadingService;
  const leer = jest.fn(
    () =>
      new Promise<LecturaDeDocumento>((r) =>
        setTimeout(() => r(lecturaDePrueba), 400),
      ),
  );
  let distA: string;
  let distB: string;
  let usuario: string;

  const adjunto = async (distributorId: string): Promise<string> => {
    const [{ attachment_id }]: Array<{ attachment_id: string }> =
      await ds.query(
        `INSERT INTO attachment (distributor_id, owner_type, owner_id, storage_key, original_name, mime_type, size_bytes, uploaded_by_user_id)
       VALUES ($1, 'insurance_installment', $2, $3, 'comprobante.pdf', 'application/pdf', 10, $4) RETURNING attachment_id`,
        [distributorId, randomUUID(), `prueba/${randomUUID()}.pdf`, usuario],
      );
    return attachment_id;
  };
  const archivo = (contenido: string) => ({
    buffer: Buffer.from(contenido),
    mimeType: 'application/pdf',
  });

  beforeAll(async () => {
    env = await createTestApp({
      overrides: [
        { token: DocumentReaderPort, value: { disponible: true, leer } },
      ],
    });
    ds = env.app.get(DataSource);
    lecturas = env.app.get(DocumentReadingService);
    [{ distributor_id: distA }] = await ds.query(
      `INSERT INTO distributor (name, slug) VALUES ('A', $1) RETURNING distributor_id`,
      [`a-${randomUUID().slice(0, 6)}`],
    );
    [{ distributor_id: distB }] = await ds.query(
      `INSERT INTO distributor (name, slug) VALUES ('B', $1) RETURNING distributor_id`,
      [`b-${randomUUID().slice(0, 6)}`],
    );
    await ds.query(
      `INSERT INTO role (type) SELECT 'admin' WHERE NOT EXISTS (SELECT 1 FROM role WHERE type = 'admin')`,
    );
    [{ user_id: usuario }] = await ds.query(
      `INSERT INTO "user" (email, full_name, phone_number, firebase_uid, role_id)
       SELECT $1, 'Admin', $2, $1, role_id FROM role WHERE type = 'admin' RETURNING user_id`,
      [
        `lecturas-${randomUUID().slice(0, 6)}@splg-test.com`,
        telefonoDePrueba(),
      ],
    );
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  beforeEach(() => leer.mockClear());

  it('el mismo archivo subido a la vez a dos adjuntos se lee y se cobra una sola vez', async () => {
    const [a1, a2] = [await adjunto(distA), await adjunto(distA)];
    const contenido = `simultaneo-${randomUUID()}`;
    const [r1, r2] = await Promise.all([
      lecturas.leerAdjunto({
        distributorId: distA,
        attachmentId: a1,
        archivo: archivo(contenido),
      }),
      lecturas.leerAdjunto({
        distributorId: distA,
        attachmentId: a2,
        archivo: archivo(contenido),
      }),
    ]);
    expect(leer).toHaveBeenCalledTimes(1);
    const estados = [r1.registro.status, r2.registro.status].sort();
    expect(estados).toEqual(
      [DocumentReadingStatus.DUPLICATE, DocumentReadingStatus.READ].sort(),
    );
    const duplicado = [r1, r2].find(
      (r) => r.registro.status === DocumentReadingStatus.DUPLICATE,
    )!;
    const original = [r1, r2].find(
      (r) => r.registro.status === DocumentReadingStatus.READ,
    )!;
    expect(duplicado.registro.duplicateOfId).toBe(original.registro.readingId);
    expect(Number(duplicado.registro.costUsd)).toBe(0);
  });

  it('dos escaneos a la vez del mismo adjunto: una lectura, sin error de único', async () => {
    const a = await adjunto(distA);
    const contenido = `mismo-adjunto-${randomUUID()}`;
    const [r1, r2] = await Promise.all([
      lecturas.leerAdjunto({
        distributorId: distA,
        attachmentId: a,
        archivo: archivo(contenido),
      }),
      lecturas.leerAdjunto({
        distributorId: distA,
        attachmentId: a,
        archivo: archivo(contenido),
      }),
    ]);
    expect(leer).toHaveBeenCalledTimes(1);
    expect(r1.registro.readingId).toBe(r2.registro.readingId);
    const [{ n }]: Array<{ n: string }> = await ds.query(
      `SELECT count(*) AS n FROM document_reading WHERE attachment_id = $1`,
      [a],
    );
    expect(Number(n)).toBe(1);
  });

  it('el mismo archivo en otra distribuidora no es duplicado: se lee en la suya', async () => {
    const contenido = `entre-tenants-${randomUUID()}`;
    await lecturas.leerAdjunto({
      distributorId: distA,
      attachmentId: await adjunto(distA),
      archivo: archivo(contenido),
    });
    const enB = await lecturas.leerAdjunto({
      distributorId: distB,
      attachmentId: await adjunto(distB),
      archivo: archivo(contenido),
    });
    expect(enB.registro.status).toBe(DocumentReadingStatus.READ);
    expect(enB.registro.duplicateOfId).toBeNull();
    expect(leer).toHaveBeenCalledTimes(2);
  });

  it('la base no deja que una lectura de B apunte a un adjunto o a un original de A', async () => {
    const deA = await adjunto(distA);
    await expect(
      ds.query(
        `INSERT INTO document_reading (distributor_id, attachment_id, file_sha256) VALUES ($1, $2, $3)`,
        [distB, deA, 'a'.repeat(64)],
      ),
    ).rejects.toThrow(/FK_document_reading_attachment_distribuidora/);
    const original = await lecturas.leerAdjunto({
      distributorId: distA,
      attachmentId: await adjunto(distA),
      archivo: archivo(`original-${randomUUID()}`),
    });
    await expect(
      ds.query(
        `INSERT INTO document_reading (distributor_id, attachment_id, file_sha256, status, duplicate_of_id, read_at)
         VALUES ($1, $2, $3, 'duplicate', $4, now())`,
        [
          distB,
          await adjunto(distB),
          'b'.repeat(64),
          original.registro.readingId,
        ],
      ),
    ).rejects.toThrow(/FK_document_reading_duplicate_of_distribuidora/);
  });

  it('los CHECK de la base: un duplicado sin original o una lectura sin fecha se rechazan', async () => {
    await expect(
      ds.query(
        `INSERT INTO document_reading (distributor_id, attachment_id, file_sha256, status, read_at) VALUES ($1, $2, $3, 'duplicate', now())`,
        [distA, await adjunto(distA), 'c'.repeat(64)],
      ),
    ).rejects.toThrow(/CHK_document_reading_duplicado/);
    await expect(
      ds.query(
        `INSERT INTO document_reading (distributor_id, attachment_id, file_sha256, status) VALUES ($1, $2, $3, 'read')`,
        [distA, await adjunto(distA), 'd'.repeat(64)],
      ),
    ).rejects.toThrow(/CHK_document_reading_leido/);
  });

  it('el gasto del mes cuenta por la fecha de lectura y no suma los duplicados', async () => {
    const [{ distributor_id: distC }]: Array<{ distributor_id: string }> =
      await ds.query(
        `INSERT INTO distributor (name, slug) VALUES ('C', $1) RETURNING distributor_id`,
        [`c-${randomUUID().slice(0, 6)}`],
      );
    const contenido = `gasto-${randomUUID()}`;
    const leida = await lecturas.leerAdjunto({
      distributorId: distC,
      attachmentId: await adjunto(distC),
      archivo: archivo(contenido),
    });
    await lecturas.leerAdjunto({
      distributorId: distC,
      attachmentId: await adjunto(distC),
      archivo: archivo(contenido),
    });
    // Subida el mes pasado y leída hoy: cuenta en el mes de hoy.
    await ds.query(
      `UPDATE document_reading SET created_at = now() - interval '40 days' WHERE reading_id = $1`,
      [leida.registro.readingId],
    );
    await expect(lecturas.gastoDelMes(distC)).resolves.toEqual({
      lecturas: 1,
      costoUsd: 0.006,
    });
  });
});
