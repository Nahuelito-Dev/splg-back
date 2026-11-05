/**
 * Módulo M6, etapa 3a: la cola y la corrida de la lectura automática contra
 * Postgres y Redis reales, con un lector de mentira (sin gastar crédito) y el
 * archivo en el MinIO efímero.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

import {
  DocumentReaderPort,
  LecturaDeDocumento,
} from '../../src/document-reader/document-reader.port';
import { TipoDeDocumento } from '../../src/document-reader/tipos-de-documento';
import { DocumentReadingQueueService } from '../../src/document-reading/document-reading-queue.service';
import { DocumentReadingRunnerService } from '../../src/document-reading/document-reading-runner.service';
import { RedisService } from '../../src/redis/redis.service';
import { S3Service } from '../../src/s3/s3.service';
import { createTestApp, telefonoDePrueba, TestEnv } from './setup/test-env';
import { startMinio, TestMinio } from './setup/minio';

jest.setTimeout(240_000);

const lectura: LecturaDeDocumento = {
  tipo: TipoDeDocumento.COMPROBANTE_DE_PAGO,
  legible: true,
  campos: [{ nombre: 'importe', valor: '100.00', confianza: 'alta' }],
  avisos: [],
  uso: {
    modelo: 'claude-opus-5-5',
    tokensDeEntrada: 1000,
    tokensDeSalida: 100,
    costoUsd: 0.4,
  },
};

describe('Lectura automática de documentos (M6 E3a, e2e)', () => {
  let env: TestEnv;
  let minio: TestMinio;
  let ds: DataSource;
  let cola: DocumentReadingQueueService;
  let corrida: DocumentReadingRunnerService;
  const leer = jest.fn<
    Promise<LecturaDeDocumento>,
    [unknown, { tipoEsperado?: string }?]
  >(() => Promise.resolve(lectura));
  let dist: string;
  let usuario: string;

  const adjunto = async (
    owner: string,
    mime = 'application/pdf',
    uploadedAt = new Date(),
  ): Promise<string> => {
    const key = `prueba/${randomUUID()}.pdf`;
    await env.app
      .get(S3Service)
      .put({ key, body: Buffer.from(`archivo ${key}`), contentType: mime });
    const [{ attachment_id }]: Array<{ attachment_id: string }> =
      await ds.query(
        `INSERT INTO attachment (distributor_id, owner_type, owner_id, storage_key, original_name, mime_type, size_bytes, uploaded_by_user_id, uploaded_at)
       VALUES ($1, $2, $3, $4, 'doc', $5, 10, $6, $7) RETURNING attachment_id`,
        [dist, owner, randomUUID(), key, mime, usuario, uploadedAt],
      );
    return attachment_id;
  };
  const configurar = (params: Record<string, number>) =>
    ds.query(
      `INSERT INTO module_config (distributor_id, module, params) VALUES ($1, 'document_reading', $2)
       ON CONFLICT (distributor_id, module) DO UPDATE SET params = EXCLUDED.params`,
      [dist, JSON.stringify(params)],
    );

  beforeAll(async () => {
    minio = await startMinio();
    env = await createTestApp({
      s3: minio.env,
      overrides: [
        { token: DocumentReaderPort, value: { disponible: true, leer } },
      ],
    });
    ds = env.app.get(DataSource);
    cola = env.app.get(DocumentReadingQueueService);
    corrida = env.app.get(DocumentReadingRunnerService);
    [{ distributor_id: dist }] = await ds.query(
      `INSERT INTO distributor (name, slug) VALUES ('D', $1) RETURNING distributor_id`,
      [`d-${randomUUID().slice(0, 6)}`],
    );
    await ds.query(
      `INSERT INTO role (type) SELECT 'admin' WHERE NOT EXISTS (SELECT 1 FROM role WHERE type = 'admin')`,
    );
    [{ user_id: usuario }] = await ds.query(
      `INSERT INTO "user" (email, full_name, phone_number, firebase_uid, role_id)
       SELECT $1, 'Admin', $2, $1, role_id FROM role WHERE type = 'admin' RETURNING user_id`,
      [`auto-${randomUUID().slice(0, 6)}@splg-test.com`, telefonoDePrueba()],
    );
  });

  afterAll(async () => {
    await env?.cleanup();
    await minio?.stop();
  });

  beforeEach(async () => {
    leer.mockClear();
    await ds.query(`DELETE FROM document_reading WHERE distributor_id = $1`, [
      dist,
    ]);
    await ds.query(`DELETE FROM attachment WHERE distributor_id = $1`, [dist]);
  });

  it('la cola: sólo PDF o imagen, de los dueños de la máscara, sin borrar y por antigüedad', async () => {
    const viejo = await adjunto(
      'insurance_installment',
      'application/pdf',
      new Date('2026-01-01'),
    );
    const nuevo = await adjunto(
      'purchase_receipt',
      'image/png',
      new Date('2026-02-01'),
    );
    await adjunto('insurance_installment', 'text/csv');
    await adjunto('order');
    const borrado = await adjunto('insurance_installment');
    await ds.query(
      `UPDATE attachment SET deleted_at = now() WHERE attachment_id = $1`,
      [borrado],
    );
    expect(
      (await cola.pendientes(dist, 10, 3, 255)).map((a) => a.attachmentId),
    ).toEqual([viejo, nuevo]);
    // Bit 8 = comprobantes de compra.
    expect(
      (await cola.pendientes(dist, 10, 3, 8)).map((a) => a.attachmentId),
    ).toEqual([nuevo]);
    expect(await cola.pendientes(dist, 1, 3, 255)).toHaveLength(1);
  });

  it('la cola: lo ya leído no vuelve; lo fallido vuelve hasta agotar los intentos', async () => {
    const leido = await adjunto('insurance_installment');
    const fallido = await adjunto('insurance_installment');
    const agotado = await adjunto('insurance_installment');
    const insertar = (
      a: string,
      status: string,
      attempts: number,
      leidoEn: string | null,
    ) =>
      ds.query(
        `INSERT INTO document_reading (distributor_id, attachment_id, file_sha256, status, attempts, read_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          dist,
          a,
          randomUUID().replace(/-/g, '').padEnd(64, '0'),
          status,
          attempts,
          leidoEn,
        ],
      );
    await insertar(leido, 'read', 1, new Date().toISOString());
    await insertar(fallido, 'failed', 1, null);
    await insertar(agotado, 'failed', 3, null);
    expect(
      (await cola.pendientes(dist, 10, 3, 255)).map((a) => a.attachmentId),
    ).toEqual([fallido]);
  });

  it('la corrida baja el archivo de S3, lo lee con el tipo esperado del dueño y lo guarda', async () => {
    await configurar({ enabled: 1, batchSize: 10, monthlyBudgetUsd: 20 });
    const cuota = await adjunto('insurance_installment');
    const resultado = await corrida.run(dist);
    expect(resultado).toMatchObject({ read: 1, failed: 0, budgetReached: 0 });
    expect(leer).toHaveBeenCalledTimes(1);
    expect(leer.mock.calls[0][1]).toMatchObject({
      tipoEsperado: 'comprobante_de_pago',
    });
    const [{ status }]: Array<{ status: string }> = await ds.query(
      `SELECT status FROM document_reading WHERE attachment_id = $1`,
      [cuota],
    );
    expect(status).toBe('read');
    // Lo leído no vuelve a leerse en la corrida siguiente.
    await expect(corrida.run(dist)).resolves.toMatchObject({ read: 0 });
    expect(leer).toHaveBeenCalledTimes(1);
  });

  it('el tope mensual no se pasa: con US$ 0,40 por lectura y tope 1, lee dos y para', async () => {
    await configurar({ enabled: 1, batchSize: 10, monthlyBudgetUsd: 1 });
    for (let i = 0; i < 5; i++) await adjunto('insurance_installment');
    const resultado = await corrida.run(dist);
    // 1ª con el costo por omisión (0,05); después el promedio es 0,40: 0,80 + 0,40 > 1.
    expect(resultado).toMatchObject({ read: 2, budgetReached: 1 });
    expect(leer).toHaveBeenCalledTimes(2);
    const [{ gasto }]: Array<{ gasto: string }> = await ds.query(
      `SELECT sum(cost_usd) AS gasto FROM document_reading WHERE distributor_id = $1`,
      [dist],
    );
    expect(Number(gasto)).toBeLessThanOrEqual(1);
  });

  it('dryRun cuenta lo pendiente sin leer ni bajar nada', async () => {
    await configurar({ enabled: 0 });
    await adjunto('insurance_installment');
    await adjunto('purchase_receipt');
    await expect(corrida.run(dist, { dryRun: true })).resolves.toMatchObject({
      read: 2,
    });
    expect(leer).not.toHaveBeenCalled();
  });

  it('un archivo que no está en S3 queda fallido con su motivo, suma intentos y deja de trabar la cola', async () => {
    await configurar({
      enabled: 1,
      batchSize: 1,
      maxAttempts: 2,
      monthlyBudgetUsd: 20,
    });
    const perdido = await adjunto(
      'insurance_installment',
      'application/pdf',
      new Date('2026-01-01'),
    );
    await ds.query(
      `UPDATE attachment SET storage_key = 'no-existe/' || attachment_id WHERE attachment_id = $1`,
      [perdido],
    );
    const bueno = await adjunto(
      'insurance_installment',
      'application/pdf',
      new Date('2026-02-01'),
    );
    interface Estado {
      status: string;
      attempts: number;
      last_error: string | null;
    }
    const estado = async (a: string): Promise<Estado> => {
      const filas: Estado[] = await ds.query(
        `SELECT status, attempts, last_error FROM document_reading WHERE attachment_id = $1`,
        [a],
      );
      return filas[0];
    };
    // Dos corridas: el perdido encabeza la cola y falla, sumando intentos.
    await expect(corrida.run(dist)).resolves.toMatchObject({ failed: 1 });
    await expect(estado(perdido)).resolves.toMatchObject({
      status: 'failed',
      attempts: 1,
    });
    expect((await estado(perdido)).last_error).toContain(
      'no está en el almacenamiento',
    );
    await expect(corrida.run(dist)).resolves.toMatchObject({ failed: 1 });
    await expect(estado(perdido)).resolves.toMatchObject({ attempts: 2 });
    // Agotados los intentos, sale de la cola y pasa el siguiente.
    await expect(corrida.run(dist)).resolves.toMatchObject({
      read: 1,
      failed: 0,
    });
    await expect(estado(bueno)).resolves.toMatchObject({ status: 'read' });
    expect(leer).toHaveBeenCalledTimes(1);
  });

  it('con una corrida en curso en la distribuidora, «correr ahora» responde 409 y no lee', async () => {
    await configurar({ enabled: 1, batchSize: 10, monthlyBudgetUsd: 20 });
    await adjunto('insurance_installment');
    const redis = env.app.get(RedisService);
    let soltar: () => void = () => undefined;
    const enCurso = redis.withLock(
      `document-reading:corrida:${dist}`,
      30_000,
      () => new Promise<void>((r) => (soltar = r)),
    );
    await new Promise((r) => setTimeout(r, 100));
    await expect(corrida.run(dist)).rejects.toThrow('en curso');
    expect(leer).not.toHaveBeenCalled();
    soltar();
    await enCurso;
    await expect(corrida.run(dist)).resolves.toMatchObject({ read: 1 });
  });
});
